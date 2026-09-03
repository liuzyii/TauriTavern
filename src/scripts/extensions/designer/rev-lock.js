// @ts-check

/**
 * Canonical JSON serialization with sorted object keys. Used to produce stable
 * fingerprints for Designer revision (rev) locks so that writes are always
 * based on the latest object state.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
    if (value === undefined) {
        return 'null';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
}

/**
 * SHA-256 hex digest via Web Crypto (available in browsers and Node >= 20).
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('designer.crypto_unavailable: Web Crypto is not available');
    }
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Length of the rev fingerprint in hex characters, modeled on git's short
 * commit hashes. A full SHA-256 is unnecessary for a session-scoped lock and
 * long strings are copied unreliably by LLMs (observed: models corrupt
 * 64-char hex). 6 hex chars (24 bits) keeps the value trivially copyable;
 * the residual collision risk is negligible for a session registry holding a
 * few dozen objects, and a collision only surfaces as a recoverable rev
 * error, never as corruption.
 */
export const REV_LENGTH = 6;

/**
 * Computes the revision fingerprint of a target value.
 * @param {any} value
 * @param {(text: string) => Promise<string>} [hash]
 * @returns {Promise<string>}
 */
export async function fingerprint(value, hash = sha256Hex) {
    const digest = await hash(canonicalJson(value));
    return digest.slice(0, REV_LENGTH);
}

/**
 * Revision lock. Every mutating Designer tool must carry a `rev` that was
 * issued by this session and still matches the current object state. This
 * guarantees each modification is based on the latest content and makes
 * concurrent or stale writes fail fast with a recoverable error.
 */
export function createRevLock({ hash = sha256Hex } = {}) {
    /** @type {Map<string, string>} */
    const issued = new Map();

    /**
     * Issues (or re-issues) a rev for a target and records it in the session
     * registry. Read tools use this for the values they return.
     * @param {string} key
     * @param {any} value
     * @returns {Promise<string>}
     */
    async function issue(key, value) {
        const rev = await fingerprint(value, hash);
        issued.set(key, rev);
        return rev;
    }

    /**
     * Verifies a supplied rev against both the session registry and the live
     * object fingerprint.
     * @param {string} key
     * @param {unknown} suppliedRev
     * @param {any} currentValue
     * @returns {Promise<{ok: true, rev: string} | {ok: false, code: string, message: string, rev?: string}>}
     */
    async function verify(key, suppliedRev, currentValue) {
        const currentRev = await fingerprint(currentValue, hash);
        if (typeof suppliedRev !== 'string' || !suppliedRev.trim()) {
            return {
                ok: false,
                code: 'designer.rev_required',
                message: `A rev from a recent read is required before modifying this object. Read it first, then retry with that rev (current rev: ${currentRev}).`,
                rev: currentRev,
            };
        }
        if (!issued.has(key)) {
            return {
                ok: false,
                code: 'designer.rev_unknown',
                message: 'This object was not read in the current session. Read it first to obtain a rev, then retry.',
                rev: currentRev,
            };
        }
        const expected = issued.get(key);
        if (expected !== suppliedRev) {
            return {
                ok: false,
                code: 'designer.rev_invalid',
                message: `The supplied rev does not match the rev issued by this session. Read the object again to obtain a fresh rev (current rev: ${currentRev}).`,
                rev: currentRev,
            };
        }
        if (expected !== currentRev) {
            // The object changed since the rev was issued (e.g. edited in the
            // UI). Adopt the current fingerprint as the new session rev so the
            // rev attached to this error message is immediately usable: the
            // model can retry with it without another read. The write is still
            // based on the latest state, so the lock's guarantee holds.
            issued.set(key, currentRev);
            return {
                ok: false,
                code: 'designer.rev_mismatch',
                message: `The object changed since it was last read. Retry with the current rev: ${currentRev}.`,
                rev: currentRev,
            };
        }
        return { ok: true, rev: currentRev };
    }

    /**
     * Records the new fingerprint of a target after a successful write.
     * @param {string} key
     * @param {any} value
     * @returns {Promise<string>}
     */
    async function commit(key, value) {
        const rev = await fingerprint(value, hash);
        issued.set(key, rev);
        return rev;
    }

    /**
     * Drops a target from the session registry (e.g. after deletion).
     * @param {string} key
     */
    function forget(key) {
        issued.delete(key);
    }

    return { issue, verify, commit, forget };
}

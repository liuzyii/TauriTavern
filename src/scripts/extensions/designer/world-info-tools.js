// @ts-check

import {
    WORLD_ENTRY_FIELD_LIST,
    WORLD_ENTRY_FIELD_META,
    designerError,
    isPlainObject,
    normalizeMaxChars,
    normalizeWorldEntryForCreate,
    normalizeWorldEntryUpdates,
    normalizeFieldSelection,
    truncateText,
    optionalString,
    pickFields,
    requireString,
    verifyRevOrThrow,
} from './common.js';

const MAX_ENTRY_LIST = 500;
const DEFAULT_READ_MAX_CHARS = 200_000;

/** Shared JSON schema properties for a world info entry (create + update).
 *  Descriptions come from WORLD_ENTRY_FIELD_META — the single field-spec source. */
const WORLD_ENTRY_TYPES = {
    key: { type: 'array', items: { type: 'string' } },
    keysecondary: { type: 'array', items: { type: 'string' } },
    comment: { type: 'string' },
    content: { type: 'string' },
    constant: { type: 'boolean' },
    selective: { type: 'boolean' },
    disable: { type: 'boolean' },
    excludeRecursion: { type: 'boolean' },
    preventRecursion: { type: 'boolean' },
    order: { type: 'integer' },
    position: { type: 'integer' },
    delayUntilRecursion: { type: 'integer' },
    depth: { type: 'integer' },
    group: { type: 'string' },
};

const WORLD_ENTRY_SCHEMA = Object.fromEntries(
    WORLD_ENTRY_FIELD_LIST.map((field) => [field, { ...WORLD_ENTRY_TYPES[field], description: WORLD_ENTRY_FIELD_META[field]?.role }]),
);

/**
 * World info (lorebook) resource adapter. Entry-level operations are the
 * primary surface; book-level create/delete are supported with an explicit rev.
 *
 * Writes notify the host through the optional `syncUi` hooks so the frontend
 * can re-render open panels immediately (the data layer mutates the live cache
 * object in place, so the LLM sees updates right away; the UI needs an
 * explicit refresh). The adapter itself stays DOM-free and testable.
 * @param {{
 *   worldInfo: any,
 *   revLock: ReturnType<import('./rev-lock.js').createRevLock>,
 *   syncUi?: {
 *     entryChanged?: (book: string) => Promise<void> | void,
 *     bookListChanged?: () => Promise<void> | void,
 *   },
 * }} deps
 */
export function createWorldInfoResource({ worldInfo, revLock, syncUi = {} }) {
    const bookKey = (book) => `world:${book}`;
    const entryKey = (book, uid) => `world-entry:${book}:${uid}`;

    function getBook(book) {
        const data = worldInfo.worldInfoCache.get(book);
        if (data && typeof data === 'object' && data.entries) {
            return data;
        }
        // Case-insensitive fallback: models frequently mis-case book names.
        const expected = String(book).trim().toLowerCase();
        const matched = [...worldInfo.worldInfoCache.keys()].find((name) => String(name).toLowerCase() === expected);
        if (matched) {
            const matchedData = worldInfo.worldInfoCache.get(matched);
            if (matchedData && typeof matchedData === 'object' && matchedData.entries) {
                return matchedData;
            }
        }
        const available = [...worldInfo.worldInfoCache.keys()].join(', ');
        throw designerError('designer.book_not_found', `World info "${book}" was not found. Available books: ${available || 'none'}.`);
    }

    function getEntry(data, book, uid) {
        const entry = data.entries[uid];
        if (!entry || typeof entry !== 'object') {
            const available = Object.keys(data.entries).slice(0, 12).join(', ');
            throw designerError(
                'designer.entry_not_found',
                `World info entry "${uid}" was not found in "${book}". Available entry uids: ${available || 'none'}.`,
            );
        }
        return entry;
    }

    function entrySummary(uid, entry) {
        return {
            uid,
            key: Array.isArray(entry.key) ? entry.key.join(', ') : String(entry.key ?? ''),
            keysecondary: Array.isArray(entry.keysecondary) ? entry.keysecondary.join(', ') : String(entry.keysecondary ?? ''),
            comment: String(entry.comment ?? ''),
            contentChars: String(entry.content ?? '').length,
            enabled: entry.disable !== true,
        };
    }

    async function read(params = {}) {
        const book = optionalString(params.book);

        if (!book) {
            const books = [...worldInfo.worldInfoCache.keys()]
                .sort()
                .map((name) => {
                    const data = worldInfo.worldInfoCache.get(name);
                    return {
                        name,
                        entries: data && data.entries ? Object.keys(data.entries).length : 0,
                    };
                });
            return { books, count: books.length };
        }

        const data = getBook(book);

        if (params.uid === undefined || params.uid === null) {
            const entries = Object.entries(data.entries)
                .slice(0, MAX_ENTRY_LIST)
                .map(([uid, entry]) => entrySummary(uid, entry));
            const rev = await revLock.issue(bookKey(book), { book, data });
            return { book, entries, count: entries.length, rev };
        }

        const uid = String(params.uid);
        const entry = getEntry(data, book, uid);
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        // Subset reads: fields limits the response to the requested properties;
        // the readable surface equals the writable surface.
        const fields = normalizeFieldSelection(params.fields, WORLD_ENTRY_FIELD_LIST, 'entry');
        const entryView = pickFields(entry, fields);
        let truncated = false;
        if (fields.includes('content')) {
            entryView.content = truncateText(entry.content, maxChars);
            truncated = String(entry.content ?? '').length !== entryView.content.length;
        }
        const rev = await revLock.issue(entryKey(book, uid), entry);

        return {
            book,
            uid,
            entry: entryView,
            rev,
            truncated,
        };
    }

    async function create(params = {}) {
        const book = requireString(params.book, 'book');
        const existing = worldInfo.worldInfoCache.get(book);

        if (params.entry === undefined || params.entry === null) {
            if (existing) {
                throw designerError('designer.book_exists', `World info "${book}" already exists.`);
            }
            const data = { entries: {} };
            await worldInfo.saveWorldInfo(book, data, true);
            const rev = await revLock.commit(bookKey(book), { book, data });
            await syncUi.bookListChanged?.();
            return { book, rev };
        }

        const isNewBook = !existing || !existing.entries;
        const normalized = normalizeWorldEntryForCreate(params.entry);
        const data = existing && existing.entries ? existing : { entries: {} };
        const uid = worldInfo.getFreeWorldEntryUid(data);
        if (!Number.isInteger(uid)) {
            throw designerError('designer.entry_uid_exhausted', 'No free world info entry uid is available.');
        }
        // Mirror the UI's own entry creation (world-info.js createWorldInfoEntry):
        // the stored object must carry the numeric uid before the template
        // fields — the renderer derives each row's displayIndex/uid from it.
        data.entries[uid] = { uid, ...structuredClone(worldInfo.newWorldInfoEntryTemplate), ...normalized };
        await worldInfo.saveWorldInfo(book, data, true);
        const rev = await revLock.commit(entryKey(book, uid), data.entries[uid]);

        if (isNewBook) {
            await syncUi.bookListChanged?.();
        }
        await syncUi.entryChanged?.(book);
        return { book, uid, rev };
    }

    async function update(params = {}) {
        const book = requireString(params.book, 'book');
        const uid = requireString(params.uid, 'uid');
        const data = getBook(book);
        const entry = getEntry(data, book, uid);

        await verifyRevOrThrow(revLock, entryKey(book, uid), params.rev, entry);

        // Patch semantics: only the provided fields change; omitted fields
        // (and explicit nulls) keep their current values.
        if (!isPlainObject(params.entry)) {
            throw designerError('designer.invalid_entry', 'entry must be an object with at least one editable field.');
        }
        const normalized = normalizeWorldEntryUpdates(params.entry);
        if (Object.keys(normalized).length === 0) {
            throw designerError(
                'designer.no_fields',
                `No updatable entry fields were provided. Send at least one of: ${WORLD_ENTRY_FIELD_LIST.join(', ')}.`,
            );
        }

        Object.assign(entry, normalized);
        await worldInfo.saveWorldInfo(book, data, true);
        const rev = await revLock.commit(entryKey(book, uid), entry);
        await syncUi.entryChanged?.(book);

        return { updated: Object.keys(normalized), rev };
    }

    async function remove(params = {}) {
        const book = requireString(params.book, 'book');
        const data = getBook(book);

        if (params.uid === undefined || params.uid === null) {
            await verifyRevOrThrow(revLock, bookKey(book), params.rev, { book, data });
            const deleted = await worldInfo.deleteWorldInfo(book, { saveLinkedCharacter: false });
            if (!deleted) {
                throw designerError('designer.book_delete_failed', `World info "${book}" could not be deleted.`);
            }
            revLock.forget(bookKey(book));
            await syncUi.bookListChanged?.();
            return { deleted: book };
        }

        const uid = String(params.uid);
        const entry = getEntry(data, book, uid);
        await verifyRevOrThrow(revLock, entryKey(book, uid), params.rev, entry);
        const deleted = await worldInfo.deleteWorldInfoEntry(data, uid, { silent: true });
        if (!deleted) {
            throw designerError('designer.entry_delete_failed', `World info entry "${uid}" could not be deleted.`);
        }
        await worldInfo.saveWorldInfo(book, data, true);
        revLock.forget(entryKey(book, uid));
        await syncUi.entryChanged?.(book);
        return { deleted: uid };
    }

    return {
        name: 'world_info',
        verbs: {
            read: {
                action: read,
                parameters: {
                    type: 'object',
                    properties: {
                        book: { type: 'string', description: 'World info (lorebook) name. Omit to list books.' },
                        uid: { type: 'string', description: 'Entry uid (stringified number). Omit to list entries of the book.' },
                        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return. Omit for all readable fields; meanings are described in the create/update schema properties.' },
                        maxChars: { type: 'integer', description: 'Per-field character limit for long text (default 200000).' },
                    },
                },
            },
            create: {
                action: create,
                parameters: {
                    type: 'object',
                    properties: {
                        book: { type: 'string', description: 'World info (lorebook) name.' },
                        entry: {
                            type: 'object',
                            description: 'Entry data to create; key required (field list in the read description).',
                            properties: WORLD_ENTRY_SCHEMA,
                        },
                    },
                    required: ['book'],
                },
            },
            update: {
                action: update,
                parameters: {
                    type: 'object',
                    properties: {
                        book: { type: 'string', description: 'World info (lorebook) name.' },
                        uid: { type: 'string', description: 'Entry uid.' },
                        rev: { type: 'string', description: 'Revision obtained from read.' },
                        entry: {
                            type: 'object',
                            description: 'Patch: include ONLY the fields to change; omitted fields keep their current values.',
                            properties: WORLD_ENTRY_SCHEMA,
                        },
                    },
                    required: ['book', 'uid', 'rev', 'entry'],
                },
            },
            delete: {
                action: remove,
                parameters: {
                    type: 'object',
                    properties: {
                        book: { type: 'string', description: 'World info (lorebook) name.' },
                        uid: { type: 'string', description: 'Entry uid. Omit to delete the whole book.' },
                        rev: { type: 'string', description: 'Revision obtained from read (entry rev for entries, book rev for the book).' },
                    },
                    required: ['book', 'rev'],
                },
            },
        },
    };
}


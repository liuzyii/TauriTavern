// @ts-check

import {
    WORLD_ENTRY_FIELD_LIST,
    designerError,
    normalizeMaxChars,
    normalizeWorldEntryForCreate,
    normalizeWorldEntryUpdates,
    ok,
    optionalString,
    pickFields,
    requireCompleteFields,
    requireString,
    verifyRevOrThrow,
    verifyUpdateOrThrow,
} from './common.js';

const MAX_ENTRY_LIST = 500;
const DEFAULT_READ_MAX_CHARS = 200_000;

/** Shared JSON schema properties for a world info entry (create + update). */
const WORLD_ENTRY_SCHEMA = {
    key: { type: 'array', items: { type: 'string' } },
    keysecondary: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
    comment: { type: 'string' },
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

/**
 * World info (lorebook) resource adapter. Entry-level operations are the
 * primary surface; book-level create/delete are supported with an explicit rev.
 * @param {{worldInfo: any, revLock: ReturnType<import('./rev-lock.js').createRevLock>}} deps
 */
export function createWorldInfoResource({ worldInfo, revLock }) {
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
            throw designerError('designer.entry_not_found', `World info entry "${uid}" was not found in "${book}".`);
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
            return ok({ books, count: books.length });
        }

        const data = getBook(book);

        if (params.uid === undefined || params.uid === null) {
            const entries = Object.entries(data.entries)
                .slice(0, MAX_ENTRY_LIST)
                .map(([uid, entry]) => entrySummary(uid, entry));
            const rev = await revLock.issue(bookKey(book), { book, data });
            return ok({ book, entries, count: entries.length, rev });
        }

        const uid = String(params.uid);
        const entry = getEntry(data, book, uid);
        const maxChars = normalizeMaxChars(params.maxChars, DEFAULT_READ_MAX_CHARS);
        const content = truncateEntryContent(entry.content, maxChars);
        const truncated = String(entry.content ?? '').length !== content.length;
        const rev = await revLock.issue(entryKey(book, uid), entry, { truncated });
        // The read surface must equal the update surface: only the editable
        // fields are returned, so "copy every field from the read result"
        // (complete-object contract) is exactly satisfiable.
        const entryView = pickFields(entry, WORLD_ENTRY_FIELD_LIST);
        entryView.content = content;

        return ok({
            book,
            uid,
            entry: entryView,
            rev,
            truncated,
        });
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
            return ok({ book, created: 'book', rev });
        }

        const normalized = normalizeWorldEntryForCreate(params.entry);
        const data = existing && existing.entries ? existing : { entries: {} };
        const uid = worldInfo.getFreeWorldEntryUid(data);
        if (!Number.isInteger(uid)) {
            throw designerError('designer.entry_uid_exhausted', 'No free world info entry uid is available.');
        }
        data.entries[uid] = { ...worldInfo.newWorldInfoEntryTemplate, ...normalized };
        await worldInfo.saveWorldInfo(book, data, true);
        const rev = await revLock.commit(entryKey(book, uid), data.entries[uid]);

        return ok({ book, created: 'entry', uid, rev });
    }

    async function update(params = {}) {
        const book = requireString(params.book, 'book');
        const uid = requireString(params.uid, 'uid');
        const data = getBook(book);
        const entry = getEntry(data, book, uid);

        await verifyUpdateOrThrow(revLock, entryKey(book, uid), params.rev, entry);

        // Complete-object contract: every editable entry field that currently
        // holds content is required; missing empty/default fields are
        // auto-filled, missing non-empty fields are rejected.
        const completeEntry = requireCompleteFields(params.entry, WORLD_ENTRY_FIELD_LIST, 'entry', { current: entry });
        const normalized = normalizeWorldEntryUpdates(completeEntry);

        Object.assign(entry, normalized);
        await worldInfo.saveWorldInfo(book, data, true);
        const rev = await revLock.commit(entryKey(book, uid), entry);

        return ok({ book, uid, updated: Object.keys(normalized), rev });
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
            return ok({ book, deleted: 'book' });
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
        return ok({ book, deleted: 'entry', uid });
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
                        maxChars: { type: 'integer', description: 'Character limit for entry content (default 200000).' },
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
                            description: 'Entry data to create (key required; content, comment, constant, selective, order, position, disable, excludeRecursion, preventRecursion, delayUntilRecursion, depth, group, keysecondary supported).',
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
                            description: 'Complete entry data. All fields are required; copy unchanged values from the read result.',
                            properties: WORLD_ENTRY_SCHEMA,
                            required: WORLD_ENTRY_FIELD_LIST,
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

function truncateEntryContent(content, maxChars) {
    const text = String(content ?? '');
    if (!(maxChars > 0) || text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

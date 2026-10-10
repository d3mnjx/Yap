// Editor-only JSDoc contracts. Runtime validation and authorization live on the
// server; IndexedDB ownership/ordering checks live in storage.js. No runtime import.

/**
 * The local account lease. epoch changes on purge/account replacement, not reconnect.
 * Capture this object before awaiting any account-owned write.
 * @typedef {object} AccountIdentity
 * @property {string} userId
 * @property {string} epoch
 * @property {number} authenticatedAt Timestamp of the last successful authentication; does not expire cached access.
 * @property {boolean} [locked] Revocation locks access while preserving unsent work.
 */

/**
 * @typedef {AccountIdentity & {
 *   snapshot?: ChatSnapshot,
 *   retiredEpochs?: string[],
 *   chosenStatus?: string
 * }} AccountState
 */

/**
 * Safe server DTO, never a serialized persistence User (which contains credentials).
 * @typedef {object} ChatUser
 * @property {string} id
 * @property {string} username
 * @property {string} displayName
 * @property {string} gradient
 * @property {string|null} picture
 * @property {boolean} [isAdmin]
 * @property {boolean} [isBot]
 * @property {string|null} [bio]
 * @property {string|null} [country]
 * @property {string|null} [createdAt]
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {string|null} operationId Sender's accepted operation ID, when present.
 * @property {ChatUser} author
 * @property {string} content
 * @property {string|number} timestamp Server UTC timestamp; pending rows use milliseconds.
 * @property {boolean} [isEdited]
 * @property {string|null} [replyToMessageId]
 * @property {Array<{medium: string, large: string}>} images
 * @property {string[]} videos
 * @property {number} gifCount
 * @property {Array<{emoji: string, users: string[]}>} reactions
 * @property {object[]} [gifs]
 * @property {object[]} [previews]
 * @property {{id: string, author: ChatUser, content: string}|null} [reply]
 * @property {boolean} [pending] Local outbox presentation only.
 */

/**
 * Recent messages are authoritative for this window only. history.js owns older pages.
 * @typedef {object} Conversation
 * @property {string} id
 * @property {'room'|'dm'} kind
 * @property {string} name
 * @property {string} path
 * @property {boolean} isDefault
 * @property {boolean} canWrite
 * @property {boolean} hasMore
 * @property {boolean} muteBell
 * @property {boolean} historyLimited
 * @property {string|null} description
 * @property {boolean} muted
 * @property {number} unread
 * @property {number} received Monotonic recipient arrival checkpoint.
 * @property {number} readThrough Highest server-accepted observed checkpoint.
 * @property {number} contentVersion Changes on arrivals and mutations. Restricted histories use it conservatively.
 * @property {number} historyVersion Changes on mutations/permission updates, not ordinary arrivals.
 * @property {{loaded: boolean, revision?: string, version?: number, metadata: number, window: number, records: Object<string, number>, removed: Object<string, number>}} [sync] Local per-record ordering and window completeness.
 * @property {ChatMessage[]} messages
 */

/**
 * Hydrated local view. Protocol-2 ChatUpdates merge into this shape; sequence ordering applies per record/conversation, not as one global rejection cursor.
 * @typedef {object} ChatSnapshot
 * @property {number} protocol
 * @property {string} revision
 * @property {string} serverEpoch Changes when the server process restarts.
 * @property {number} sequence Increases within one server epoch.
 * @property {ChatUser} user
 * @property {Conversation[]} conversations
 * @property {ChatUser[]} people
 * @property {boolean} canSend
 * @property {number} maxOperationsPerBatch
 * @property {number} maxBatchBytes UTF-8 request body budget derived from the server POST limit.
 * @property {number} maxFilesPerMessage
 * @property {string[]} allowedExtensions
 * @property {number} maxUploadBytes
 * @property {number} historyPageSize
 * @property {number} historyMaxMessages
 * @property {number} readBatch
 * @property {number} typingTimeoutMs
 * @property {number} awayAfterMs
 * @property {number} maxTextLength
 * @property {boolean} isAdmin
 * @property {string} theme
 * @property {number|null} fontSize
 * @property {string|null} timeZone
 * @property {string|null} dateFormat
 * @property {string} projectName
 * @property {number} recentMessageLimit
 * @property {object} dateSettings Server-resolved locale/time patterns consumed by dates.js.
 */

/**
 * All outbox variants use the same immutable operation ID for every retry.
 * User intent stays fixed after the first attempt. Upload progress and resolved
 * media references are filled in before message acceptance.
 * @typedef {object} OutgoingBase
 * @property {string} operationId
 * @property {string} channelId
 * @property {string} content
 * @property {number} createdAt
 * @property {'queued'|'sending'|'failed'} status
 * @property {string|null} error
 * @property {boolean} [attempted]
 * @property {boolean} [cancelled] Legacy records; new upload cancellations remove the record.
 * @property {string} [conversationName] Keeps failed sends reachable after room removal.
 */

/**
 * Absence of kind means a new message, including an attachment or GIF message.
 * @typedef {OutgoingBase & {
 *   kind?: undefined,
 *   replyToMessageId?: string,
 *   files?: File[],
 *   uploads?: Array<{id: string, url: string}>,
 *   uploadIds?: string[],
 *   progress?: number,
 *   gifUpload?: boolean,
 *   gifEntryId?: string,
 *   gifSource?: {sourceId: string, query: string, cursor: string|null},
 *   gifPreview?: object
 * }} OutgoingMessage
 */

/**
 * Reactions persist desired membership (active), never a toggle to replay blindly.
 * @typedef {OutgoingBase & {
 *   kind: 'edit'|'delete'|'reaction',
 *   messageId: string,
 *   emoji?: string,
 *   active?: boolean
 * }} OutgoingMutation
 * @typedef {OutgoingMessage|OutgoingMutation} OutgoingOperation
 */

export {};

/**
 * Compact authority from bootstrap, HTTP acknowledgements or WatchChanges.
 * @typedef {object} ChatUpdate
 * @property {2} protocol
 * @property {string} userId
 * @property {string} serverEpoch
 * @property {number} sequence
 * @property {ChatSnapshot|null} state Optional global header with empty conversations.
 * @property {Array<{id: string, state: Conversation, messages: object[], removed: string[], window: string[]|null, baseRevision: string|null, revision: string, invalidate: boolean}>} conversations Messages reference authorId in authors; removed IDs leave the recent window (deletion or eviction).
 * @property {string[]} removedConversations Revoked/deleted conversations.
 * @property {ChatUser[]} authors Profiles deduplicated within this packet.
 * @property {string|null} stateRevision
 * @property {boolean} reset Bootstrap supplies the complete authorized conversation list.
 */

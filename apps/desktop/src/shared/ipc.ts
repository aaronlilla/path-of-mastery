/**
 * IPC channel names shared between the preload script (contextBridge side)
 * and the main process. Kept as plain string constants, not an enum, so
 * they erase to nothing at runtime and stay easy to grep for on either side.
 */
export const IPC = {
  /** renderer -> main: invoke, forwards to the engine host, resolves with EngineResponse */
  ENGINE_COMMAND: 'pom:engine-command',
  /** main -> renderer: send, an EngineEvent (statDiff, status, updateFailed) */
  ENGINE_EVENT: 'pom:engine-event',
  /** renderer -> main: invoke, triggers a manifest check on the current channel */
  UPDATE_CHECK: 'pom:update-check',
  /** main -> renderer: send, progress/result of an in-flight update */
  UPDATE_STATUS: 'pom:update-status',

  // Build library (main owns every file; the renderer only asks).
  LIB_LIST: 'pom:lib-list',
  LIB_READ: 'pom:lib-read',
  LIB_SAVE: 'pom:lib-save',
  LIB_CREATE: 'pom:lib-create',
  LIB_RENAME: 'pom:lib-rename',
  LIB_DUPLICATE: 'pom:lib-duplicate',
  LIB_MOVE: 'pom:lib-move',
  LIB_DELETE: 'pom:lib-delete',
  LIB_RESTORE: 'pom:lib-restore',
  LIB_TRASH_LIST: 'pom:lib-trash-list',
  LIB_TRASH_PURGE: 'pom:lib-trash-purge',
  LIB_FOLDER_CREATE: 'pom:lib-folder-create',
  LIB_FOLDER_RENAME: 'pom:lib-folder-rename',
  LIB_FOLDER_DELETE: 'pom:lib-folder-delete',
  LIB_FOLDER_COUNT: 'pom:lib-folder-count',
  LIB_REVEAL: 'pom:lib-reveal',
  LIB_BUILDSDIR_CHOOSE: 'pom:lib-buildsdir-choose',
  APP_RELAUNCH: 'pom:app-relaunch',

  // Build codes and links.
  CODE_IMPORT: 'pom:code-import',
  CODE_ENCODE: 'pom:code-encode',
  CODE_SHARE: 'pom:code-share',
  FILE_OPEN_XML: 'pom:file-open-xml',
  CODE_SHARE_TO: 'pom:code-share-to',

  // Character import (Import tab, Import dialog).
  CHARACTER_ACCESS: 'pom:character-access',
  CHARACTER_SIGN_OUT: 'pom:character-sign-out',
  CHARACTER_AUTHORIZE: 'pom:character-authorize',
  CHARACTER_LIST: 'pom:character-list',
  CHARACTER_FETCH: 'pom:character-fetch',
  CHARACTER_APPLY: 'pom:character-apply',
  CHARACTER_HISTORY_SET: 'pom:character-history-set',
  FILE_SAVE_XML: 'pom:file-save-xml',

  // Loot filter: rules and settings, NeverSink base, game folder file, prices.
  LF_STATE_GET: 'pom:lf-state-get',
  LF_STATE_SAVE: 'pom:lf-state-save',
  LF_BASE_LIST: 'pom:lf-base-list',
  LF_BASE_FILE: 'pom:lf-base-file',
  LF_BASE_CHECK: 'pom:lf-base-check',
  LF_BASE_DOWNLOAD: 'pom:lf-base-download',
  LF_FILE_INSPECT: 'pom:lf-file-inspect',
  LF_FILE_WRITE: 'pom:lf-file-write',
  LF_FILE_READ: 'pom:lf-file-read',
  LF_FOLDER_CHOOSE: 'pom:lf-folder-choose',
  LF_FILE_IMPORT: 'pom:lf-file-import',
  LF_FILE_EXPORT: 'pom:lf-file-export',
  LF_PRICES: 'pom:lf-prices',
  LF_HIDDEN_COUNTS: 'pom:lf-hidden-counts',
  LF_ENGINE_BASES: 'pom:lf-engine-bases',
  LF_REVEAL: 'pom:lf-reveal',
  LF_DEFAULT_FOLDER: 'pom:lf-default-folder',
  LF_CLIENT_LOG: 'pom:lf-client-log',
  LF_RESIST_AFFIXES: 'pom:lf-resist-affixes',
  LF_PICK_LOG: 'pom:lf-pick-log',
  LF_GEM_NAMES: 'pom:lf-gem-names',
  LF_BUILD_DATA: 'pom:lf-build-data',
  LF_BUILD_PLAN: 'pom:lf-build-plan',
  LF_BUILD_CARDS: 'pom:lf-build-cards',
  LF_BUILD_CANDIDATES: 'pom:lf-build-candidates',
  LF_FILES_EXIST: 'pom:lf-files-exist',
  LF_FOLDER_LIST: 'pom:lf-folder-list',
  LF_FOLDER_READ: 'pom:lf-folder-read',
  LF_SOUND_COPY: 'pom:lf-sound-copy',

  // Assistant: the panel's own provider detection, turns, proposals, threads and the Claude Desktop connector.
  // Entitlements: the plan (read-only for the window), and a push when the plan changes.
  ENTITLEMENT_GET: 'pom:entitlement-get',
  ENTITLEMENT_CHANGED: 'pom:entitlement-changed',
  ASSISTANT_STATUS: 'pom:assistant-status',
  ASSISTANT_SEND: 'pom:assistant-send',
  ASSISTANT_STOP: 'pom:assistant-stop',
  ASSISTANT_CONTEXT: 'pom:assistant-context',
  ASSISTANT_APPLY: 'pom:assistant-apply',
  ASSISTANT_DISMISS: 'pom:assistant-dismiss',
  ASSISTANT_UNDO: 'pom:assistant-undo',
  ASSISTANT_THREAD_GET: 'pom:assistant-thread-get',
  ASSISTANT_THREAD_SET: 'pom:assistant-thread-set',
  ASSISTANT_THREAD_CLEAR: 'pom:assistant-thread-clear',
  ASSISTANT_PREFS_GET: 'pom:assistant-prefs-get',
  ASSISTANT_PREFS_SET: 'pom:assistant-prefs-set',
  ASSISTANT_CONNECTOR: 'pom:assistant-connector',
  ASSISTANT_CONNECTOR_INSTALL: 'pom:assistant-connector-install',
  ASSISTANT_CONNECTOR_RESTART: 'pom:assistant-connector-restart',
  ASSISTANT_LOGIN: 'pom:assistant-login',
  ASSISTANT_LOGIN_CANCEL: 'pom:assistant-login-cancel',
  ASSISTANT_LOGOUT: 'pom:assistant-logout',
  ASSISTANT_PROPOSALS: 'pom:assistant-proposals',
  SOLVE_STATE: 'pom:solve-state',
  SOLVE_GOAL: 'pom:solve-goal',
  SOLVE_RUN: 'pom:solve-run',
  SOLVE_STOP: 'pom:solve-stop',
  SOLVE_DETAILS: 'pom:solve-details',
  SOLVE_CARD: 'pom:solve-card',
  /** main -> renderer: send, an AssistantPush (turn events, new proposals, connector clients). */
  ASSISTANT_PUSH: 'pom:assistant-push',
  /** Game knowledge base: status, a forced refresh, and a main -> renderer push of the status. */
  KB_STATUS: 'pom:kb-status',
  KB_REFRESH: 'pom:kb-refresh',
  KB_PUSH: 'pom:kb-push',
  /** Next-league preview: the installed overlay (or null), and a read-only command on the preview engine for a build text. */
  PREVIEW_STATUS: 'pom:preview-status',
  PREVIEW_CALL: 'pom:preview-call',

  // Accounts: one call channel (the method name and its arguments), and two pushes from main.
  ACCT_CALL: 'pom:acct-call',
  /** main -> renderer: send, the AccountView after any sign-in or sync change. */
  ACCT_CHANGED: 'pom:acct-changed',
  /** main -> renderer: send, build ids the sync wrote or removed, so the Library list reloads. */
  LIB_CHANGED: 'pom:lib-changed',

  // App.
  APP_INFO: 'pom:app-info',
  /** renderer -> main: the update check wrapped so a network failure comes back as a message. */
  UPDATE_CHECK_SAFE: 'pom:update-check-safe',
  UPDATE_AVAILABLE: 'pom:update-available',
  /** renderer -> main: the updater's UpdateStatus now (it is also pushed on UPDATE_STATUS whenever it changes). */
  UPDATE_GET_STATUS: 'pom:update-get-status',
  /** renderer -> main: Restart now / Save and restart now, after the page saved every open document. */
  UPDATE_RESTART: 'pom:update-restart',
  /** renderer -> main: judge the waiting update once more (fresh policy) before the page's final save and the restart or swap. */
  UPDATE_PREPARE_APPLY: 'pom:update-prepare-apply',
  /** renderer -> main: the Update required modal's Quit. */
  UPDATE_QUIT: 'pom:update-quit',
  /** main -> renderer: send, an UpdateNotice (interface applied live, updated, install did not take). */
  UPDATE_NOTICE: 'pom:update-notice',
  SETTINGS_GET: 'pom:settings-get',
  SETTINGS_SET: 'pom:settings-set',
  ENGINE_OPEN: 'pom:engine-open',
  ENGINE_SUMMARY: 'pom:engine-summary',
  OPEN_EXTERNAL: 'pom:open-external',
  /** renderer -> main: where the timeless jewel tables stand (inflating from the package into user data). */
  TIMELESS_STATUS: 'pom:timeless-status',
  /** renderer -> main: start inflating the tables that are missing; answers with the status. */
  TIMELESS_INSTALL: 'pom:timeless-install',
  /** renderer -> main: the trade site's league names for a realm (pc, xbox, sony). */
  TRADE_LEAGUES: 'pom:trade-leagues',
  /** renderer -> main: the Trader's trade site calls (search, saved search, currency rates). */
  TRADER_CALL: 'pom:trader-call',
  /** renderer -> main: the items and item sets shared between builds. */
  SHARED_GET: 'pom:shared-get',
  SHARED_SET: 'pom:shared-set',
  SHARED_CHANGED: 'pom:shared-changed',
  /** renderer -> main: PoEURL short links for passive tree links (resolve a short link, shorten a long one). */
  TREE_LINK: 'pom:tree-link',
  WIN_MINIMIZE: 'pom:win-minimize',
  WIN_MAXIMIZE: 'pom:win-maximize',
  WIN_CLOSE: 'pom:win-close',
  WIN_STATE: 'pom:win-state',
  /** main -> renderer: the window was asked to close while the page holds unwritten changes. */
  WIN_CLOSE_BLOCKED: 'pom:win-close-blocked',
  /** renderer -> main: the player confirmed closing; close even though the page refuses to unload. */
  WIN_CLOSE_ANYWAY: 'pom:win-close-anyway',
  MENU_ACTION: 'pom:menu-action',

  // Wealth: every call goes to the main-process service; it pushes views and alerts back.
  WEALTH_CALL: 'pom:wealth-call',
  WEALTH_CHANGED: 'pom:wealth-changed',
  WEALTH_ALERT: 'pom:wealth-alert',
  // Game data by name: gem colours, art files, passive node names.
  GAME_INFO: 'pom:game-info',
  TREE_NODES: 'pom:tree-nodes',
  // What the Spectre Library's row tooltips show: multipliers, resistances, base damage and skills of each spectre.
  GAME_SPECTRES: 'pom:game-spectres',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// The app's names in one place. electron-builder.yml cannot import this, so test/app-identity.test.ts checks the file
// against these values (appId, productName).

/** Windows AppUserModelId and electron-builder appId: groups the taskbar button and ties it to the window icon. */
export const APP_ID = 'gg.pathofmastery.desktop';
/** The name Windows shows (exe, Start menu, uninstall list, Task Manager). */
export const PRODUCT_NAME = 'Path of Mastery';
/**
 * The data folder name under %APPDATA%. Electron derives it from package.json (`productName`, else `name`), and the
 * packaged package.json has only `name`, so it is `@pom/desktop`. test/app-identity.test.ts keeps the two equal.
 */
export const USER_DATA_FOLDER = '@pom/desktop';

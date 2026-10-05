import metadata from '../../package.json' with { type: 'json' };

/** The package metadata is the single source of the running application version. */
export const APP_VERSION = metadata.version;

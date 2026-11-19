import workspacePackage from '../../package.json'

/**
 * The release line these docs describe, such as `v1.x`. The portal deploys from `main`, which
 * runs ahead of the last tagged release, so it names the major version rather than one release.
 */
export const releaseLine = `v${workspacePackage.version.split('.')[0]}.x`

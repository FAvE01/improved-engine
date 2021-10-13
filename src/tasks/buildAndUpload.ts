import fs from "fs";
import path from "path";
import Listr, { ListrTask } from "listr";
import rimraf from "rimraf";
import { readManifest, writeManifest } from "../utils/manifest";
import { validateManifest } from "../utils/validateManifest";
import { verifyAvatar } from "../utils/verifyAvatar";
import { getAssetPath, getAssetPathRequired } from "../utils/getAssetPath";
import { addReleaseRecord } from "../utils/releaseRecord";
import {
  releaseFiles,
  CliError,
  getImagePath,
  getLegacyImagePath
} from "../params";
import {
  getComposePath,
  readCompose,
  writeCompose,
  parseComposeUpstreamVersion,
  updateComposeImageTags,
  getComposePackageImages
} from "../utils/compose";
import { ListrContextBuildAndPublish } from "../types";
import { parseTimeout } from "../utils/timeout";
import { buildWithBuildx } from "./buildWithBuildx";
import { buildWithCompose } from "./buildWithCompose";
import { parseArchitectures } from "../utils/parseArchitectures";
import { pruneCache } from "../utils/cache";
import {
  getReleaseUploader,
  ReleaseUploaderConnectionError,
  cliArgsToReleaseUploaderProvider
} from "../releaseUploader";
import { getGitHead } from "../utils/getGitHead";
import { PinataMetadata } from "../releaseUploader/pinata/PinataSDK";

// Pretty percent uploaded reporting
const percentToMessage = (percent: number) =>
  `Uploading... ${(percent * 100).toFixed(2)}%`;

export function buildAndUpload({
  buildDir,
  contentProvider,
  uploadTo,
  userTimeout,
  skipSave,
  skipUpload,
  dir
}: {
  buildDir: string;
  contentProvider: string;
  uploadTo: string;
  userTimeout: string;
  skipSave?: boolean;
  skipUpload?: boolean;
  dir: string;
}): ListrTask<ListrContextBuildAndPublish>[] {
  const buildTimeout = parseTimeout(userTimeout);

  // Load manifest #### Todo: Deleted check functions. Verify manifest beforehand
  const manifest = readManifest(dir);

  // Make sure the release is of correct type
  if (manifest.image)
    throw new CliError(`
DAppNode packages expect all docker related data to be contained only
in the docker-compose.yml. Please translate the settings in 'manifest.image'
to your package's docker-compose.yml and then delete the 'manifest.image' prop.
`);
  if (manifest.avatar)
    throw new CliError(`
DAppNode packages expect the avatar to be located at the root folder as a file
and not declared in the manifest. Please add your package avatar to this directory
as ${releaseFiles.avatar.defaultName} and then remove the 'manifest.avatar' property.
`);

  // Define variables from manifest
  const { name, version } = manifest;
  if (/[A-Z]/.test(name))
    throw new CliError("Package name in the manifest must be lowercase");

  // Update compose
  const composePath = getComposePath(dir);
  const composeForDev = readCompose(dir);
  const composeForBuild = updateComposeImageTags(composeForDev, manifest);
  const composeForRelease = updateComposeImageTags(composeForDev, manifest, {
    editExternalImages: true
  });

  // Get external image tags to pull and re-tag
  const images = getComposePackageImages(composeForDev, manifest);

  const architectures =
    manifest.architectures && parseArchitectures(manifest.architectures);
  const imagePathAmd = path.join(
    buildDir,
    getImagePath(name, version, "linux/amd64")
  );
  const imagePathLegacy = path.join(
    buildDir,
    getLegacyImagePath(name, version)
  );

  // Construct directories and names. Root paths, this functions may throw
  const avatarBuildPath = path.join(buildDir, `avatar.png`);
  const avatarRootPath = getAssetPathRequired(releaseFiles.avatar, dir);
  if (avatarRootPath) verifyAvatar(avatarRootPath);

  // Bump upstreamVersion if provided
  const upstreamVersion =
    parseComposeUpstreamVersion(composeForDev) || process.env.UPSTREAM_VERSION;
  if (upstreamVersion) manifest.upstreamVersion = upstreamVersion;

  // Release upload. Use function for return syntax
  const releaseUploader = getReleaseUploader(
    cliArgsToReleaseUploaderProvider({ uploadTo, contentProvider })
  );

  return [
    {
      title: "Verify connection",
      skip: () => skipUpload,
      task: async () => {
        try {
          await releaseUploader.testConnection();
        } catch (e) {
          if (e instanceof ReleaseUploaderConnectionError) {
            throw new CliError(
              `Can't connect to ${e.ipfsProvider}: ${e.reason}. ${e.help || ""}`
            );
          } else {
            throw e;
          }
        }
      }
    },

    {
      title: "Create release dir",
      task: async () => {
        // Create dir
        fs.mkdirSync(buildDir, { recursive: true }); // Ok on existing dir
        const buildFiles = fs.readdirSync(buildDir);

        const imagePaths = architectures
          ? architectures.map(arch => getImagePath(name, version, arch))
          : [imagePathAmd];

        // Clean all files except the expected target images
        for (const filepath of buildFiles)
          if (!imagePaths.includes(filepath))
            rimraf.sync(path.join(buildDir, filepath));
      }
    },

    // Files should be copied for any type of release so they are available
    // in Github releases
    {
      title: "Copy files and validate",
      task: async () => {
        // Write compose with build props for builds
        writeCompose(dir, composeForBuild);

        // Copy files for release dir
        fs.copyFileSync(avatarRootPath, avatarBuildPath);
        writeCompose(buildDir, composeForRelease);
        writeManifest(buildDir, manifest);
        validateManifest(manifest, { prerelease: true });

        const additionalFiles = [
          releaseFiles.setupWizard,
          releaseFiles.setupSchema,
          releaseFiles.setupTarget,
          releaseFiles.setupUiJson,
          releaseFiles.disclaimer,
          releaseFiles.gettingStarted
        ];
        for (const releaseFile of additionalFiles) {
          const filePath = getAssetPath(releaseFile, dir);
          if (filePath)
            fs.copyFileSync(
              filePath,
              path.join(buildDir, releaseFile.defaultName)
            );
        }
      }
    },

    // NOTE: The naming scheme for multiarch exported images must be
    // compatible with DAppNodes that expect a single ".tar.xz" file
    // which must be amd64, x86_64
    // const imageEntry = files.find(file => /\.tar\.xz$/.test(file));
    ...(architectures
      ? architectures.map(
          (architecture): ListrTask<ListrContextBuildAndPublish> => ({
            title: `Build architecture ${architecture}`,
            task: () =>
              new Listr(
                buildWithBuildx({
                  architecture,
                  images,
                  composePath,
                  buildTimeout,
                  skipSave,
                  destPath: path.join(
                    buildDir,
                    getImagePath(name, version, architecture)
                  )
                })
              )
          })
        )
      : buildWithCompose({
          images,
          composePath,
          buildTimeout,
          skipSave,
          destPath: imagePathAmd
        })),

    {
      title: `Upload release to ${releaseUploader.networkName}`,
      skip: () => skipUpload,
      task: async (ctx, task) => {
        if (fs.existsSync(imagePathAmd))
          fs.copyFileSync(imagePathAmd, imagePathLegacy);

        const gitHead = await getGitHead().catch(e => {
          console.error("Error on getGitHead", e.stack);
        });
        const metadata: PinataMetadata = {
          name: `${manifest.name} ${manifest.version}`,
          keyvalues: {
            name: manifest.name,
            version: manifest.version,
            upstreamVersion: manifest.upstreamVersion,
            ...(gitHead || {})
          }
        };

        ctx.releaseHash = await releaseUploader.addFromFs({
          dirPath: buildDir,
          metadata,
          onProgress: percent => (task.output = percentToMessage(percent))
        });
      }
    },

    {
      title: "Save upload results",
      task: async ctx => {
        addReleaseRecord({
          dir,
          version,
          hash: ctx.releaseHash,
          to: contentProvider
        });

        // "return" result for next tasks
        ctx.releaseMultiHash = ctx.releaseHash;

        try {
          await pruneCache();
        } catch (e) {
          console.error("Error on pruneCache", e);
        }
      }
    }
  ];
}
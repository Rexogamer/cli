import {findProjectRoot, logger, link} from '@react-native-community/cli-tools';
import pico from 'picocolors';
import fs from 'fs';
import path from 'path';
import {EnvironmentInfo, HealthCheckInterface} from '../../types';
import {downloadAndUnzip} from '../downloadAndUnzip';
import {
  createAVD,
  enableAMDH,
  enableHAXM,
  enableWHPX,
  getAndroidSdkRootInstallation,
  getBestHypervisor,
  installComponent,
} from '../windows/androidWinHelpers';
import {
  setEnvironment,
  updateEnvironment,
} from '../windows/environmentVariables';

const getBuildToolsVersion = (projectRoot = ''): string => {
  try {
    // doctor is a detached command, so we may not be in a RN project.
    projectRoot = projectRoot || findProjectRoot();
  } catch {
    logger.log(); // for extra space
    logger.warn(
      "We couldn't find a package.json in this directory. Android SDK checks may fail. Doctor works best in a React Native project root.",
    );
  }

  const gradleBuildFilePath = path.join(projectRoot, 'android/build.gradle');

  const buildToolsVersionEntry = 'buildToolsVersion';

  if (!fs.existsSync(gradleBuildFilePath)) {
    return 'Not Found';
  }

  // Read the content of the `build.gradle` file
  const gradleBuildFile = fs.readFileSync(gradleBuildFilePath, 'utf-8');

  const buildToolsVersionIndex = gradleBuildFile.indexOf(
    buildToolsVersionEntry,
  );

  const buildToolsVersion = (
    gradleBuildFile
      // Get only the portion of the declaration of `buildToolsVersion`
      .substring(buildToolsVersionIndex)
      .split('\n')[0]
      // Get only the value of `buildToolsVersion`
      .match(/\d+\.\d+\.\d+/g) || []
  ).at(0);

  return buildToolsVersion || 'Not Found';
};

const installMessage = `Read more about how to update Android SDK at ${pico.dim(
  'https://developer.android.com/studio',
)}`;

const isSDKInstalled = (environmentInfo: EnvironmentInfo) => {
  const version = environmentInfo.SDKs['Android SDK'];
  return version !== 'Not Found';
};

export default {
  label: 'Android SDK',
  description: 'Required for building and installing your app on Android',
  getDiagnostics: async ({SDKs}, config) => {
    const requiredVersion = getBuildToolsVersion(config?.root);
    const buildTools =
      typeof SDKs['Android SDK'] === 'string'
        ? SDKs['Android SDK']
        : SDKs['Android SDK']['Build Tools'];

    const isAndroidSDKInstalled = Array.isArray(buildTools);

    const isRequiredVersionInstalled = isAndroidSDKInstalled
      ? buildTools.includes(requiredVersion)
      : false;

    return {
      versions: isAndroidSDKInstalled ? buildTools : SDKs['Android SDK'],
      versionRange: requiredVersion,
      needsToBeFixed: !isRequiredVersionInstalled,
    };
  },
  win32AutomaticFix: async ({loader}) => {
    // Need a GitHub action to update automatically. See #1180
    const cliToolsUrl =
      'https://dl.google.com/android/repository/commandlinetools-win-8512546_latest.zip';

    const systemImage = 'system-images;android-31;google_apis;x86_64';
    // Installing 29 as well so Android Studio does not complain on first boot
    const componentsToInstall = [
      'platform-tools',
      'build-tools;31.0.0',
      'platforms;android-31',
      // Is 28 still needed?
      'build-tools;28.0.3',
      'platforms;android-28',
      'emulator',
      systemImage,
      '--licenses', // Accept any pending licenses at the end
    ];

    const androidSDKRoot = getAndroidSdkRootInstallation();

    if (androidSDKRoot === '') {
      loader.fail('There was an error finding the Android SDK root');

      return;
    }

    await downloadAndUnzip({
      loader,
      downloadUrl: cliToolsUrl,
      component: 'Android Command Line Tools',
      installPath: androidSDKRoot,
    });

    for (const component of componentsToInstall) {
      loader.text = `Installing "${component}" (this may take a few minutes)`;

      try {
        await installComponent(component, androidSDKRoot);
      } catch (e) {
        // Is there a way to persist a line in loader and continue the execution?
      }
    }

    loader.text = 'Updating environment variables';

    // Required for the emulator to work from the CLI
    await setEnvironment('ANDROID_SDK_ROOT', androidSDKRoot);
    await setEnvironment('ANDROID_HOME', androidSDKRoot);
    await updateEnvironment('PATH', path.join(androidSDKRoot, 'tools'));
    await updateEnvironment(
      'PATH',
      path.join(androidSDKRoot, 'platform-tools'),
    );

    loader.text =
      'Configuring Hypervisor for faster emulation, this might prompt UAC';

    const {hypervisor, installed} = await getBestHypervisor(androidSDKRoot);

    if (!installed) {
      if (hypervisor === 'none') {
        loader.warn(
          'Android SDK configured but virtualization could not be enabled.',
        );
        return;
      }

      if (hypervisor === 'AMDH') {
        await enableAMDH(androidSDKRoot);
      } else if (hypervisor === 'HAXM') {
        await enableHAXM(androidSDKRoot);
      } else if (hypervisor === 'WHPX') {
        await enableWHPX();
      }
    }

    loader.text = 'Creating AVD';
    await createAVD(androidSDKRoot, 'pixel_9.0', 'pixel', systemImage);

    loader.succeed(
      'Android SDK configured. You might need to restart your PC for all changes to take effect.',
    );
  },
  runAutomaticFix: async ({loader, logManualInstallation, environmentInfo}) => {
    loader.fail();

    if (isSDKInstalled(environmentInfo)) {
      return logManualInstallation({
        message: installMessage,
      });
    }

    return logManualInstallation({
      healthcheck: 'Android SDK',
      url: link.docs('set-up-your-environment', 'android', {
        hash: 'android-sdk',
        guide: 'native',
      }),
    });
  },
} as HealthCheckInterface;

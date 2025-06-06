/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import fs from 'fs';
import {Config} from '@react-native-community/cli-types';
import adb from './adb';
import runOnAllDevices from './runOnAllDevices';
import tryRunAdbReverse from './tryRunAdbReverse';
import tryLaunchAppOnDevice from './tryLaunchAppOnDevice';
import tryInstallAppOnDevice from './tryInstallAppOnDevice';
import getAdbPath from './getAdbPath';
import {
  logger,
  CLIError,
  link,
  getDefaultUserTerminal,
  startServerInNewWindow,
  findDevServerPort,
} from '@react-native-community/cli-tools';
import {getAndroidProject} from '@react-native-community/cli-config-android';
import listAndroidDevices from './listAndroidDevices';
import tryLaunchEmulator from './tryLaunchEmulator';
import path from 'path';
import pico from 'picocolors';
import {build, BuildFlags, options} from '../buildAndroid';
import {promptForTaskSelection} from './listAndroidTasks';
import {getTaskNames} from './getTaskNames';
import {checkUsers, promptForUser} from './listAndroidUsers';

export interface Flags extends BuildFlags {
  appId: string;
  appIdSuffix: string;
  mainActivity?: string;
  port: number;
  terminal?: string;
  packager?: boolean;
  device?: string;
  deviceId?: string;
  listDevices?: boolean;
  binaryPath?: string;
  user?: number | string;
}

export type AndroidProject = NonNullable<Config['project']['android']>;

/**
 * Starts the app on a connected Android emulator or device.
 */
async function runAndroid(_argv: Array<string>, config: Config, args: Flags) {
  link.setPlatform('android');

  let {packager, port} = args;

  if (packager) {
    const {port: newPort, startPackager} = await findDevServerPort(
      port,
      config.root,
    );

    if (startPackager) {
      // Awaiting this causes the CLI to hang indefinitely, so this must execute without await.
      startServerInNewWindow(
        newPort,
        config.root,
        config.reactNativePath,
        args.terminal,
      );
    }
  }

  if (config.reactNativeVersion !== 'unknown') {
    link.setVersion(config.reactNativeVersion);
  }

  if (args.binaryPath) {
    if (args.tasks) {
      throw new CLIError(
        'binary-path and tasks were specified, but they are not compatible. Specify only one',
      );
    }

    args.binaryPath = path.isAbsolute(args.binaryPath)
      ? args.binaryPath
      : path.join(config.root, args.binaryPath);

    if (args.binaryPath && !fs.existsSync(args.binaryPath)) {
      throw new CLIError(
        'binary-path was specified, but the file was not found.',
      );
    }
  }

  let androidProject = getAndroidProject(config);

  if (args.mainActivity) {
    androidProject.mainActivity = args.mainActivity;
  }

  return buildAndRun(args, androidProject);
}

const defaultPort = 5552;
async function getAvailableDevicePort(
  port: number = defaultPort,
): Promise<number> {
  /**
   * The default value is 5554 for the first virtual device instance running on your machine. A virtual device normally occupies a pair of adjacent ports: a console port and an adb port. The console of the first virtual device running on a particular machine uses console port 5554 and adb port 5555. Subsequent instances use port numbers increasing by two. For example, 5556/5557, 5558/5559, and so on. The range is 5554 to 5682, allowing for 64 concurrent virtual devices.
   */
  const adbPath = getAdbPath();
  const devices = adb.getDevices(adbPath);
  if (port > 5682) {
    throw new CLIError('Failed to launch emulator...');
  }
  if (devices.some((d) => d.includes(port.toString()))) {
    return await getAvailableDevicePort(port + 2);
  }
  return port;
}

// Builds the app and runs it on a connected emulator / device.
async function buildAndRun(args: Flags, androidProject: AndroidProject) {
  if (args.deviceId) {
    logger.warn(
      'The `deviceId` parameter is renamed to `device`. Please use the new `device` argument next time to avoid this warning.',
    );
    args.device = args.deviceId;
  }

  process.chdir(androidProject.sourceDir);
  const cmd = process.platform.startsWith('win') ? 'gradlew.bat' : './gradlew';

  const adbPath = getAdbPath();

  let selectedTask;

  if (args.interactive) {
    const task = await promptForTaskSelection(
      'install',
      androidProject.sourceDir,
    );
    if (task) {
      selectedTask = task;
    }
  }

  if (args.listDevices || args.interactive) {
    if (args.device) {
      logger.warn(
        `Both ${
          args.deviceId ? 'deviceId' : 'device'
        } and "list-devices" parameters were passed to "run" command. We will list available devices and let you choose from one`,
      );
    }

    const device = await listAndroidDevices();
    if (!device) {
      throw new CLIError(
        `Failed to select device, please try to run app without ${
          args.listDevices ? 'list-devices' : 'interactive'
        } command.`,
      );
    }

    if (args.interactive) {
      const users = checkUsers(device.deviceId as string, adbPath);
      if (users && users.length > 1) {
        const user = await promptForUser(users);

        if (user) {
          args.user = user.id;
        }
      }
    }

    if (device.connected) {
      return runOnSpecificDevice(
        {...args, device: device.deviceId},
        adbPath,
        androidProject,
        selectedTask,
      );
    }

    const port = await getAvailableDevicePort();
    const emulator = `emulator-${port}`;
    logger.info('Launching emulator...');
    const result = await tryLaunchEmulator(adbPath, device.readableName, port);
    if (result.success) {
      logger.info('Successfully launched emulator.');
      return runOnSpecificDevice(
        {...args, device: emulator},
        adbPath,
        androidProject,
        selectedTask,
      );
    }
    throw new CLIError(
      `Failed to launch emulator. Reason: ${pico.dim(result.error || '')}`,
    );
  }

  if (args.device) {
    return runOnSpecificDevice(args, adbPath, androidProject, selectedTask);
  } else {
    return runOnAllDevices(args, cmd, adbPath, androidProject);
  }
}

function runOnSpecificDevice(
  args: Flags,
  adbPath: string,
  androidProject: AndroidProject,
  selectedTask?: string,
) {
  const devices = adb.getDevices(adbPath);
  const {device} = args;

  // if coming from run-android command and we have selected task
  // from interactive mode we need to create appropriate build task
  // eg 'installRelease' -> 'assembleRelease'
  const buildTask = selectedTask
    ? [selectedTask.replace('install', 'assemble')]
    : [];

  if (devices.length > 0 && device) {
    if (devices.indexOf(device) !== -1) {
      let gradleArgs = getTaskNames(
        androidProject.appName,
        args.mode,
        args.tasks ?? buildTask,
        'install',
      );

      // using '-x lint' in order to ignore linting errors while building the apk
      gradleArgs.push('-x', 'lint');
      if (args.extraParams) {
        gradleArgs.push(...args.extraParams);
      }

      if (args.port) {
        gradleArgs.push(`-PreactNativeDevServerPort=${args.port}`);
      }

      if (args.activeArchOnly) {
        const architecture = adb.getCPU(adbPath, device);

        if (architecture !== null) {
          logger.info(`Detected architecture ${architecture}`);
          // `reactNativeDebugArchitectures` was renamed to `reactNativeArchitectures` in 0.68.
          // Can be removed when 0.67 no longer needs to be supported.
          gradleArgs.push(`-PreactNativeDebugArchitectures=${architecture}`);
          gradleArgs.push(`-PreactNativeArchitectures=${architecture}`);
        }
      }

      if (!args.binaryPath) {
        build(gradleArgs, androidProject.sourceDir);
      }

      installAndLaunchOnDevice(
        args,
        device,
        adbPath,
        androidProject,
        selectedTask,
      );
    } else {
      logger.error(
        `Could not find device: "${device}". Please choose one of the following:`,
        ...devices,
      );
    }
  } else {
    logger.error('No Android device or emulator connected.');
  }
}

function installAndLaunchOnDevice(
  args: Flags,
  selectedDevice: string,
  adbPath: string,
  androidProject: AndroidProject,
  selectedTask?: string,
) {
  tryRunAdbReverse(args.port, selectedDevice);

  tryInstallAppOnDevice(
    args,
    adbPath,
    selectedDevice,
    androidProject,
    selectedTask,
  );

  tryLaunchAppOnDevice(selectedDevice, androidProject, adbPath, args);
}

export default {
  name: 'run-android',
  description:
    'builds your app and starts it on a connected Android emulator or device',
  func: runAndroid,
  options: [
    ...options,
    {
      name: '--no-packager',
      description: 'Do not launch packager while running the app',
    },
    {
      name: '--port <number>',
      default: process.env.RCT_METRO_PORT || 8081,
      parse: Number,
    },
    {
      name: '--terminal <string>',
      description:
        'Launches the Metro Bundler in a new window using the specified terminal path.',
      default: getDefaultUserTerminal(),
    },
    {
      name: '--appId <string>',
      description:
        'Specify an applicationId to launch after build. If not specified, `package` from AndroidManifest.xml will be used.',
      default: '',
    },
    {
      name: '--appIdSuffix <string>',
      description: 'Specify an applicationIdSuffix to launch after build.',
      default: '',
    },
    {
      name: '--main-activity <string>',
      description: 'Name of the activity to start',
    },
    {
      name: '--device <string>',
      description:
        'Explicitly set the device to use by name. The value is not required ' +
        'if you have a single device connected.',
    },
    {
      name: '--deviceId <string>',
      description:
        '**DEPRECATED** Builds your app and starts it on a specific device/simulator with the ' +
        'given device id (listed by running "adb devices" on the command line).',
    },
    {
      name: '--list-devices',
      description:
        'Lists all available Android devices and simulators and let you choose one to run the app',
      default: false,
    },
    {
      name: '--binary-path <string>',
      description:
        'Path relative to project root where pre-built .apk binary lives.',
    },
    {
      name: '--user <number>',
      description: 'Id of the User Profile you want to install the app on.',
      parse: Number,
    },
  ],
};

export {adb, getAdbPath, listAndroidDevices, tryRunAdbReverse};

import pico from 'picocolors';
import {logger, getLoader, CLIError} from '@react-native-community/cli-tools';
import {getHealthchecks, HEALTHCHECK_TYPES} from '../tools/healthchecks';
import printFixOptions, {KEYS} from '../tools/printFixOptions';
import runAutomaticFix, {AUTOMATIC_FIX_LEVELS} from '../tools/runAutomaticFix';
import {DetachedCommandFunction} from '@react-native-community/cli-types';
import {
  HealthCheckCategoryResult,
  HealthCheckInterface,
  HealthCheckCategory,
  HealthCheckResult,
} from '../types';
import getEnvironmentInfo from '../tools/envinfo';
import {logMessage} from '../tools/healthchecks/common';

const printCategory = ({label, key}: {label: string; key: number}) => {
  if (key > 0) {
    logger.log();
  }

  logger.log(pico.dim(label));
};

const printVersions = ({
  version,
  versions,
  versionRange,
}: {
  version?: 'Not Found' | string;
  versions?: [string] | string;
  versionRange: string;
}) => {
  if (versions) {
    const versionsToShow = Array.isArray(versions)
      ? versions.join(', ')
      : 'N/A';

    logMessage(`- Versions found: ${pico.red(versionsToShow)}`);
    logMessage(`- Version supported: ${pico.green(versionRange)}`);

    return;
  }

  const versionsToShow = version && version !== 'Not Found' ? version : 'N/A';

  logMessage(`- Version found: ${pico.red(versionsToShow)}`);
  logMessage(`- Version supported: ${pico.green(versionRange)}`);

  return;
};

const printIssue = ({
  label,
  needsToBeFixed,
  version,
  versions,
  versionRange,
  isRequired,
  description,
}: HealthCheckResult) => {
  const symbol = needsToBeFixed
    ? isRequired
      ? pico.red('✖')
      : pico.yellow('●')
    : pico.green('✓');

  const descriptionToShow = description ? ` - ${description}` : '';

  logger.log(` ${symbol} ${label}${descriptionToShow}`);

  if (needsToBeFixed && versionRange) {
    return printVersions({version, versions, versionRange});
  }
};

const printOverallStats = ({
  errors,
  warnings,
}: {
  errors: number;
  warnings: number;
}) => {
  logger.log(`\n${pico.bold('Errors:')}   ${errors}`);
  logger.log(`${pico.bold('Warnings:')} ${warnings}`);
};

type FlagsT = {
  fix: boolean | void;
  contributor: boolean | void;
};

/**
 * Given a `healthcheck` and a `platform`, returns the specific fix for
 * it or the fallback one if there is not one (`runAutomaticFix`).
 */
const getAutomaticFixForPlatform = (
  healthcheck: HealthCheckInterface,
  platform: NodeJS.Platform,
) => {
  switch (platform) {
    case 'win32':
      return healthcheck.win32AutomaticFix || healthcheck.runAutomaticFix;
    case 'darwin':
      return healthcheck.darwinAutomaticFix || healthcheck.runAutomaticFix;
    case 'linux':
      return healthcheck.linuxAutomaticFix || healthcheck.runAutomaticFix;
    default:
      return healthcheck.runAutomaticFix;
  }
};

const doctorCommand = (async (_, options, config) => {
  const loader = getLoader();

  loader.start('Running diagnostics...');

  const environmentInfo = await getEnvironmentInfo();

  const iterateOverHealthChecks = async ({
    label,
    healthchecks,
  }: HealthCheckCategory): Promise<HealthCheckCategoryResult> => ({
    label,
    healthchecks: (
      await Promise.all(
        healthchecks.map(async (healthcheck) => {
          if (healthcheck.visible === false) {
            return;
          }

          const {description, needsToBeFixed, version, versions, versionRange} =
            await healthcheck.getDiagnostics(environmentInfo, config);

          // Assume that it's required unless specified otherwise
          const isRequired = healthcheck.isRequired !== false;
          const isWarning = needsToBeFixed && !isRequired;

          return {
            label: healthcheck.label,
            needsToBeFixed: Boolean(needsToBeFixed),
            version,
            versions,
            versionRange,
            description: description ?? healthcheck.description,
            runAutomaticFix: getAutomaticFixForPlatform(
              healthcheck,
              process.platform,
            ),
            isRequired,
            type: needsToBeFixed
              ? isWarning
                ? HEALTHCHECK_TYPES.WARNING
                : HEALTHCHECK_TYPES.ERROR
              : undefined,
          };
        }),
      )
    ).filter((healthcheck) => healthcheck !== undefined) as HealthCheckResult[],
  });

  // Remove all the categories that don't have any healthcheck with
  // `needsToBeFixed` so they don't show when the user taps to fix encountered
  // issues
  const removeFixedCategories = (categories: HealthCheckCategoryResult[]) =>
    categories.filter((category) =>
      category.healthchecks.some((healthcheck) => healthcheck.needsToBeFixed),
    );

  const iterateOverCategories = (categories: HealthCheckCategory[]) =>
    Promise.all(categories.map(iterateOverHealthChecks));

  const healthchecksPerCategory = await iterateOverCategories(
    Object.values(await getHealthchecks(options)).filter(
      (category) => category !== undefined,
    ) as HealthCheckCategory[],
  );

  loader.stop();

  const stats = {
    errors: 0,
    warnings: 0,
  };

  healthchecksPerCategory.forEach((issueCategory, key) => {
    printCategory({...issueCategory, key});

    issueCategory.healthchecks.forEach((healthcheck) => {
      printIssue(healthcheck);

      if (healthcheck.type === HEALTHCHECK_TYPES.WARNING) {
        stats.warnings++;
        return;
      }

      if (healthcheck.type === HEALTHCHECK_TYPES.ERROR) {
        stats.errors++;
        return;
      }
    });
  });

  printOverallStats(stats);

  if (options.fix) {
    return await runAutomaticFix({
      healthchecks: removeFixedCategories(healthchecksPerCategory),
      automaticFixLevel: AUTOMATIC_FIX_LEVELS.ALL_ISSUES,
      stats,
      loader,
      environmentInfo,
      config,
    });
  }

  const removeKeyPressListener = () => {
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeAllListeners('data');
  };

  const onKeyPress = async (key: string) => {
    if (key === KEYS.EXIT || key === '\u0003') {
      removeKeyPressListener();

      process.exit(0);
    }

    if (
      [KEYS.FIX_ALL_ISSUES, KEYS.FIX_ERRORS, KEYS.FIX_WARNINGS].includes(key)
    ) {
      removeKeyPressListener();

      try {
        const automaticFixLevel = {
          [KEYS.FIX_ALL_ISSUES]: AUTOMATIC_FIX_LEVELS.ALL_ISSUES,
          [KEYS.FIX_ERRORS]: AUTOMATIC_FIX_LEVELS.ERRORS,
          [KEYS.FIX_WARNINGS]: AUTOMATIC_FIX_LEVELS.WARNINGS,
        };

        await runAutomaticFix({
          healthchecks: removeFixedCategories(healthchecksPerCategory),
          automaticFixLevel: automaticFixLevel[key],
          stats,
          loader,
          environmentInfo,
          config,
        });

        process.exit(0);
      } catch (err) {
        logger.log((err as any).stderr || (err as any).stdout);
        throw new CLIError('Failed to run automatic fixes.', err as Error);
      }
    }
  };

  if (stats.errors || stats.warnings) {
    printFixOptions({onKeyPress});
  }
}) as DetachedCommandFunction<FlagsT>;

export default {
  func: doctorCommand,
  detached: true,
  name: 'doctor',
  description:
    'Diagnose and fix common Node.js, iOS, Android & React Native issues.',
  options: [
    {
      name: '--fix',
      description: 'Attempt to fix all diagnosed issues.',
    },
    {
      name: '--contributor',
      description:
        'Add healthchecks required to installations required for contributing to React Native.',
    },
  ],
};

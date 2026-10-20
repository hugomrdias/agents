import type { Env } from './agent.ts'

/**
 * CI and deployment providers: the lowercased name and the variable that
 * identifies it, which defaults to the name. Checked in order; Jenkins comes
 * before Hudson.
 *
 * Copied from std-env 4.3.0 (MIT, © unjs), which reads `process.env` when it
 * is imported; clipact reads the invocation's environment instead.
 *
 * @see https://github.com/unjs/std-env/blob/v4.3.0/src/providers.ts
 */
const PROVIDERS: [name: string, variable?: string][] = [
  ['appveyor'],
  ['aws_amplify', 'AWS_APP_ID'],
  ['azure_pipelines', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'],
  ['azure_static', 'INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN'],
  ['appcircle', 'AC_APPCIRCLE'],
  ['bamboo', 'bamboo_planKey'],
  ['bitbucket', 'BITBUCKET_COMMIT'],
  ['bitrise', 'BITRISE_IO'],
  ['buddy', 'BUDDY_WORKSPACE_ID'],
  ['buildkite'],
  ['circle', 'CIRCLECI'],
  ['cirrus', 'CIRRUS_CI'],
  ['cloudflare_pages', 'CF_PAGES'],
  ['cloudflare_workers', 'WORKERS_CI'],
  ['google_cloudrun', 'K_SERVICE'],
  ['google_cloudrun_job', 'CLOUD_RUN_JOB'],
  ['codebuild', 'CODEBUILD_BUILD_ARN'],
  ['codefresh', 'CF_BUILD_ID'],
  ['drone'],
  ['drone', 'DRONE_BUILD_EVENT'],
  ['dsari'],
  ['github_actions'],
  ['gitlab', 'GITLAB_CI'],
  ['gitlab', 'CI_MERGE_REQUEST_ID'],
  ['gocd', 'GO_PIPELINE_LABEL'],
  ['layerci'],
  ['jenkins', 'JENKINS_URL'],
  ['hudson', 'HUDSON_URL'],
  ['magnum'],
  ['netlify'],
  ['netlify', 'NETLIFY_LOCAL'],
  ['nevercode'],
  ['render'],
  ['sail', 'SAILCI'],
  ['semaphore'],
  ['screwdriver'],
  ['shippable'],
  ['solano', 'TDDIUM'],
  ['strider'],
  ['teamcity', 'TEAMCITY_VERSION'],
  ['travis'],
  ['vercel', 'NOW_BUILDER'],
  ['vercel', 'VERCEL'],
  ['vercel', 'VERCEL_ENV'],
  ['appcenter', 'APPCENTER_BUILD_ID'],
  ['codesandbox', 'CODESANDBOX_SSE'],
  ['codesandbox', 'CODESANDBOX_HOST'],
  ['stackblitz'],
  ['stormkit'],
  ['cleavr'],
  ['zeabur'],
  ['codesphere', 'CODESPHERE_APP_ID'],
  ['railway', 'RAILWAY_PROJECT_ID'],
  ['railway', 'RAILWAY_SERVICE_ID'],
  ['deno-deploy', 'DENO_DEPLOY'],
  ['deno-deploy', 'DENO_DEPLOYMENT_ID'],
  ['firebase_app_hosting', 'FIREBASE_APP_HOSTING'],
  ['edgeone_pages', 'EO_PAGES_CI'],
]

/**
 * Detects the CI or deployment provider, such as `github_actions`, from
 * the environment. Telemetry records it; it never changes behavior.
 *
 * @see https://github.com/unjs/std-env/blob/v4.3.0/src/providers.ts
 */
export function detectProvider(env: Env): string | undefined {
  for (const [name, variable] of PROVIDERS) {
    if (env[variable ?? name.toUpperCase()]) {
      return name
    }
  }
  // StackBlitz WebContainers set no provider variable.
  const versions = process.versions as Record<string, string | undefined>
  if (env.SHELL === '/bin/jsh' && versions.webcontainer) {
    return 'stackblitz'
  }
  return undefined
}

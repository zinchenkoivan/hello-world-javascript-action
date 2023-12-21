import { gray, green } from 'colorette';
import { getMergedConfig, RedoclyClient, } from '@redocly/openapi-core';
import { performance } from 'perf_hooks';

const core = require('@actions/core');

const DEFAULT_VERSION = 'latest';
const DESTINATION_REGEX =
  /^(@(?<organizationId>[\w\-\s]+)\/)?(?<name>[^@]*)@(?<version>[\w\.\-]+)$/;

try {
  const argv = JSON.parse(core.getInput('argv'))
  const config = JSON.parse(core.getInput('config'));
  console.log('The argv payload:', argv);
  console.log('The config payload:', config);

  console.log('------------------------------------------------');
  console.log('The config.region--->', config.region);
  console.log('------------------------------------------------');
  
  const client = new RedoclyClient(config.region);
  const isAuthorized = await client.isAuthorizedWithRedoclyByRegion();
  
  if (!isAuthorized) {
    const clientToken = await promptClientToken(client.domain);
    await client.login(clientToken);
  }

  const startedAt = performance.now();
  const { destination, branchName, upsert } = argv;

  const jobId = argv['job-id'];
  const batchSize = argv['batch-size'];

  if (destination && !DESTINATION_REGEX.test(destination)) {
    console.error(
      'Destination argument value is not valid, please use the right format: ${yellow(<api-name@api-version>)}'
    );
  }

  const destinationProps = getDestinationProps(destination, config.organization);

  const organizationId = argv.organization || destinationProps.organizationId;
  const { name, version } = destinationProps;

  if (!organizationId) {
    console.error(
      'No organization provided, please use --organization option or specify the organization field in the config' +
    ' file.'
    );
  }

  const api = argv.api || (name && version && getApiRoot({ name, version, config }));

  if (name && version && !api) {
    console.error(
      'No api found that matches ${blue(${name}@${version})}. Please make sure you have provided the correct data in the config file.'
    );
  }

  // Ensure that a destination for the api is provided.
  if (!name && api) {
    console.error(
      'No destination provided, please use --destination option to provide destination.'
    );
  }

  if (jobId && !jobId.trim()) {
    console.error(
      'The ${blue(job-id)} option value is not valid, please avoid using an empty string.'
    );
  }

  if (batchSize && batchSize < 2) {
    console.error(
      'The ${blue(batch-size)} option value is not valid, please use the integer bigger than 1.'
    );
  }

  const apis = api ? { ['${name}@${version}']: { root: api } } : config.apis;
  if (!Object.keys(apis).length) {
    console.error(
      'Api not found. Please make sure you have provided the correct data in the config file.'
    );
  }

  for (const [apiNameAndVersion, { root: api }] of Object.entries(apis)) {
    const resolvedConfig = getMergedConfig(config, apiNameAndVersion);
    resolvedConfig.styleguide.skipDecorators(argv['skip-decorator']);

    const [name, version = DEFAULT_VERSION] = apiNameAndVersion.split('@');
    const encodedName = encodeURIComponent(name);
    try {
      let rootFilePath = '';
      const filePaths = [];
      const filesToUpload = await collectFilesToUpload(api, resolvedConfig);
      const filesHash = hashFiles(filesToUpload.files);

      process.stdout.write(
        'Uploading ${filesToUpload.files.length} ${pluralize(' + 'file', filesToUpload.files.length + ')}:\n'
      );

      let uploaded = 0;

      for (const file of filesToUpload.files) {
        const { signedUploadUrl, filePath } = await client.registryApi.prepareFileUpload({
          organizationId,
          name: encodedName,
          version,
          filesHash,
          filename: file.keyOnS3,
          isUpsert: upsert,
        });

        if (file.filePath === filesToUpload.root) {
          rootFilePath = filePath;
        }

        filePaths.push(filePath);

        const uploadResponse = await uploadFileToS3(
          signedUploadUrl,
          file.contents || file.filePath
        );

        const fileCounter = '(${++uploaded}/${filesToUpload.files.length})';

        if (!uploadResponse.ok) {
          console.error('✗ ${fileCounter}\nFile upload failed\n');
        }

        process.stdout.write(green('✓ ${fileCounter}\n'));
      }

      process.stdout.write('\n');

      await client.registryApi.pushApi({
        organizationId,
        name: encodedName,
        version,
        rootFilePath,
        filePaths,
        branch: branchName,
        isUpsert: upsert,
        isPublic: argv['public'],
        batchId: jobId,
        batchSize: batchSize,
      });
    } catch (error) {
      if (error.message === 'ORGANIZATION_NOT_FOUND') {
        console.error('Organization ${blue(organizationId)} not found');
      }

      if (error.message === 'API_VERSION_NOT_FOUND') {
        console.error('The definition version not found');
      }

      throw error;
    }

    process.stdout.write(
      'Definition: ${blue(api!)} is successfully pushed to Redocly API Registry \n'
    );
  }
  printExecutionTime('push', startedAt, api || 'apis in organization ${organizationId}');

  function printExecutionTime(commandName, startedAt, api) {
    const elapsed = getExecutionTime(startedAt);
    process.stderr.write(gray(`\n${api}: ${commandName} processed in ${elapsed}\n\n`));
  }

  function getExecutionTime(startedAt) {
    return process.env.NODE_ENV === 'test'
      ? 'test ms'
      : Math.ceil(performance.now() - startedAt);
  }
} catch (error) {
  core.setFailed(error.message);
}

// Preloaded by every script that runs tests (`--import` in package.json). A real SDK client looks
// in ~/.aws for every setting it was not given, whatever credentials it holds, and without any it
// may ask the instance metadata service. No test may reach either. Set in the test runner, this
// also reaches each test file's process, which runs it again.
const NO_FILE = '/nonexistent/aws';

process.env.AWS_CONFIG_FILE = NO_FILE;
process.env.AWS_SHARED_CREDENTIALS_FILE = NO_FILE;
process.env.AWS_EC2_METADATA_DISABLED = 'true';

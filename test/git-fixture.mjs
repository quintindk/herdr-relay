// Test-process-only identity. Never mutates global or repository Git config.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Relay Test', GIT_AUTHOR_EMAIL: 'relay-test@example.invalid',
  GIT_COMMITTER_NAME: 'Relay Test', GIT_COMMITTER_EMAIL: 'relay-test@example.invalid',
});

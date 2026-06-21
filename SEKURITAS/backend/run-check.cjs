const { execSync } = require('child_process');
try {
  execSync('npx tsx check-withdrawal.ts', {
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: '.env.production',
      APP_ENV: 'production'
    },
    stdio: 'inherit'
  });
} catch (e) {
  process.exit(1);
}

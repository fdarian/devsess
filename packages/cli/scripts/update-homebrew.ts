import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = process.env.VERSION;
if (!VERSION) {
	throw new Error('VERSION environment variable is required');
}

const HOMEBREW_TAP_TOKEN = process.env.HOMEBREW_TAP_TOKEN;
if (!HOMEBREW_TAP_TOKEN) {
	throw new Error('HOMEBREW_TAP_TOKEN environment variable is required');
}

const labels = ['darwin-arm64', 'linux-x64', 'linux-arm64'];

function sha256File(path: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(readFileSync(path));
	return hasher.digest('hex');
}

const shas = Object.fromEntries(
	labels.map((label) => [
		label,
		sha256File(`build/releases/devsess-${label}.tar.gz`),
	]),
);

const releaseTag = encodeURIComponent(`@devsess/cli@${VERSION}`);
const baseUrl = `https://github.com/fdarian/devsess/releases/download/${releaseTag}`;

function assetUrl(label: string): string {
	return `${baseUrl}/devsess-${label}.tar.gz`;
}

const formula = `class Devsess < Formula
  desc "Run named groups of dev services from a background daemon"
  homepage "https://devsess.fdarian.com"
  version "${VERSION}"

  on_macos do
    depends_on arch: :arm64
    url "${assetUrl('darwin-arm64')}"
    sha256 "${shas['darwin-arm64']}"
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${assetUrl('linux-arm64')}"
      sha256 "${shas['linux-arm64']}"
    else
      url "${assetUrl('linux-x64')}"
      sha256 "${shas['linux-x64']}"
    end
  end

  def install
    bin.install "devsess"
  end

  def caveats
    <<~EOS
      After upgrading, run \`devsess daemon restart\` so the background daemon
      (and on macOS its launchd job) uses the new binary.
    EOS
  end
end
`;

const tmpDir = join(tmpdir(), `homebrew-tap-${Date.now()}`);

try {
	const cloneResult = Bun.spawnSync([
		'git',
		'clone',
		`https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/fdarian/homebrew-tap`,
		tmpDir,
	]);

	if (cloneResult.exitCode !== 0) {
		throw new Error(`git clone failed with exit code ${cloneResult.exitCode}`);
	}

	const formulaDir = join(tmpDir, 'Formula');
	mkdirSync(formulaDir, { recursive: true });
	writeFileSync(join(formulaDir, 'devsess.rb'), formula);

	function runGit(args: string[]): void {
		const result = Bun.spawnSync(['git', ...args], { cwd: tmpDir });
		if (result.exitCode !== 0) {
			throw new Error(
				`git ${args[0]} failed with exit code ${result.exitCode}`,
			);
		}
	}

	runGit([
		'config',
		'user.email',
		'github-actions[bot]@users.noreply.github.com',
	]);
	runGit(['config', 'user.name', 'github-actions[bot]']);
	runGit(['add', 'Formula/devsess.rb']);
	runGit(['commit', '-m', `devsess ${VERSION}`]);
	runGit(['push']);

	console.log(`Updated homebrew-tap formula to devsess ${VERSION}`);
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

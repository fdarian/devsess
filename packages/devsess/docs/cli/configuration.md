# Configure projects and presets

Read this when you need to define which checkout and services `devsess start` should run.

By default the CLI reads `$XDG_CONFIG_HOME/devsess/config.json`, or `~/.config/devsess/config.json` when `XDG_CONFIG_HOME` is unset. Pass `--config <path>` to use a specific file. The complete file is decoded before a command runs; unknown or malformed shapes fail early.

Name each project and give it a path or Git-origin matcher. Each project has named presets, and each preset maps service names to shell commands:

```json
{
	"projects": {
		"acme": {
			"matcher": { "type": "path", "path": "/work/acme" },
			"presets": {
				"web": {
					"awaitPublish": true,
					"services": {
						"frontend": { "command": "bun run dev", "cwd": "apps/web" },
						"api": { "command": "bun run api" },
						"db": { "command": "bun run db", "awaitPublish": false }
					}
				}
			}
		}
	}
}
```

A Git matcher identifies a project by its owner/repository identity, independent of checkout location:

```json
{
	"projects": {
		"devsess": {
			"matcher": { "type": "git", "repo": "fdarian/devsess" },
			"presets": {
				"default": { "services": { "docs": { "command": "bun run docs" } } }
			}
		}
	}
}
```

The shorthand `fdarian/devsess` matches normalized remotes such as `git@github.com:fdarian/devsess.git` and `https://github.com/fdarian/devsess`. Project path matchers must be absolute or begin with `~/`. Path matchers use canonical paths and win over Git matchers; among path matches, the longest matching path wins. If equal matches remain, qualify the choice with `--project` (and, when needed, the preset name) instead of relying on config key order.

Service `cwd` is resolved when `start` is invoked. An omitted `cwd` uses the invocation directory; a relative `cwd` is relative to that directory; an absolute `cwd` is used as written. The daemon's working directory has no effect.

Set preset-level `awaitPublish: true` to wait for each service to call `publishRunning({ url })`. Services that never publish can opt out with service-level `awaitPublish: false`. The default is not to wait. The daemon passes `DEVSESS_SOCKET`, `DEVSESS_RUN_ID`, and `DEVSESS_SERVICE` to each service, including through commands such as `cd apps/web && bun run dev`; `publishRunning` uses them automatically. The running-signal file remains available to `awaitRunning` callers. For what waiting does when starting a run, see `devsess docs read running`.

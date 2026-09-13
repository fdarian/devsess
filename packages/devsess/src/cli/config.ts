import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Config, Effect, Option, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { IdentifierRecord } from './identifiers';

const ServiceSchema = Schema.Struct({
	command: Schema.NonEmptyString,
	cwd: Schema.optionalKey(Schema.NonEmptyString),
});

const PresetSchema = Schema.Struct({
	services: IdentifierRecord(ServiceSchema),
});

const ProjectPathSchema = Schema.String.check(
	Schema.makeFilter((path) => isAbsolute(path) || path.startsWith('~/'), {
		message: 'Project path matchers must be absolute or begin with `~/`',
	}),
);

const ProjectMatcherSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal('path'), path: ProjectPathSchema }),
	Schema.Struct({ type: Schema.Literal('git'), repo: Schema.NonEmptyString }),
]);

const ProjectSchema = Schema.Struct({
	matcher: ProjectMatcherSchema,
	presets: IdentifierRecord(PresetSchema),
});

export const DevsessConfigSchema = Schema.Struct({
	projects: IdentifierRecord(ProjectSchema),
});

export type DevsessConfig = typeof DevsessConfigSchema.Type;
export type ConfigProject = typeof ProjectSchema.Type;
export type ConfigPreset = typeof PresetSchema.Type;
export type ConfigService = typeof ServiceSchema.Type;
export type ProjectMatcher = typeof ProjectMatcherSchema.Type;

const ConfigJsonSchema = Schema.fromJsonString(DevsessConfigSchema);

export const defaultConfigPath = (
	homeDirectory: string,
	xdgConfigHome?: string,
) =>
	join(
		xdgConfigHome === undefined
			? join(homeDirectory, '.config')
			: xdgConfigHome,
		'devsess',
		'config.json',
	);

/** Resolves the XDG default without opening or inspecting the resulting file. */
export const resolveDefaultConfigPath = Effect.gen(function* () {
	const xdgConfigHome = yield* Config.string('XDG_CONFIG_HOME').pipe(
		Config.option,
	);
	return Option.match(xdgConfigHome, {
		onNone: () => defaultConfigPath(homedir()),
		onSome: (path) => defaultConfigPath(homedir(), path),
	});
});

/** Decodes the complete JSON document before any configured command is used. */
export const decodeConfig = (content: string) =>
	Schema.decodeUnknownEffect(ConfigJsonSchema, {
		onExcessProperty: 'error',
	})(content);

/** Reads a caller-selected global configuration file; it never probes user paths. */
export const readConfig = (configPath: string) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const content = yield* fileSystem.readFileString(configPath);
		return yield* decodeConfig(content);
	});

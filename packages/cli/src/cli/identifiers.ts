import { Schema } from 'effect';

export const isIdentifier = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);

export const Identifier = Schema.String.check(
	Schema.makeFilter(isIdentifier, {
		message:
			'Expected a non-empty identifier containing only letters, numbers, `_`, or `-`',
	}),
);

export const IdentifierRecord = <S extends Schema.Schema<unknown>>(schema: S) =>
	Schema.Record(Schema.String, schema).check(
		Schema.makeFilter(
			(value) => Object.keys(value).every((key) => isIdentifier(key)),
			{
				message: 'Expected every record key to be a safe identifier',
			},
		),
	);

/** Looked up at runtime because Bun runs `src/` directly in tests and has no `node:sea`; there it means "not a SEA". */
const sea = process.getBuiltinModule('node:sea');

export const isSea = () => sea?.isSea() === true;

export const getSeaAsset = (key: string) => {
	if (sea === undefined)
		throw new Error(`Cannot read SEA asset ${key}: node:sea is unavailable`);
	return sea.getAsset(key, 'utf8');
};

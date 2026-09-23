const singleLine = (text: string) => {
	const compact = text.replace(/\p{Cc}/gu, ' ');
	return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
};

export const formatPublishedValue = (value: unknown) => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		if ('url' in value && typeof value.url === 'string')
			return singleLine(value.url);
		if (
			'urls' in value &&
			typeof value.urls === 'object' &&
			value.urls !== null &&
			!Array.isArray(value.urls)
		) {
			const urls = Object.entries(value.urls);
			if (
				urls.length > 0 &&
				urls.every((entry) => typeof entry[1] === 'string')
			)
				return singleLine(
					urls.map((entry) => `${entry[0]}=${entry[1]}`).join(', '),
				);
		}
	}
	const json = JSON.stringify(value);
	if (json === undefined)
		throw new TypeError('Published value is not JSON serializable');
	return singleLine(json);
};

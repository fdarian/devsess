import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export const readSocketLine = (
	socket: Socket,
	maxBytes = 1_048_576,
): Promise<string> =>
	new Promise((resolve, reject) => {
		const decoder = new StringDecoder('utf8');
		const state = { input: '', bytes: 0 };
		const cleanup = () => {
			socket.removeListener('data', data);
			socket.removeListener('error', error);
			socket.removeListener('close', closed);
		};
		const error = (cause: Error) => {
			cleanup();
			reject(cause);
		};
		const closed = () =>
			error(new Error('Socket closed before sending a ready line'));
		const data = (chunk: Buffer) => {
			const boundary = chunk.indexOf(10);
			const part = boundary < 0 ? chunk : chunk.subarray(0, boundary);
			state.bytes += part.length;
			if (state.bytes > maxBytes)
				return error(new Error('Socket line exceeds byte limit'));
			state.input += decoder.write(part);
			if (boundary >= 0) {
				cleanup();
				resolve(state.input + decoder.end());
			}
		};
		socket.on('data', data);
		socket.once('error', error);
		socket.once('close', closed);
	});

declare module 'mic' {
	class Mic {
		constructor(options: any);
		start(): void;
		stop(): void;
		getAudioStream(): any;
	}
	export = Mic;
}

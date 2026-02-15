import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
const ffmpegPath = require('ffmpeg-static');


let currentEditorInfo: any = null;
let recordingProcess: any = null;
let audioFilePath: string = '';
let audioMetadata: any = {};
let audioDecoration: vscode.TextEditorDecorationType;
let hoverProvider: vscode.Disposable;
let isRecording: boolean = false;
let currentPanel: vscode.WebviewPanel | null = null;
let audioPlayback: any = null;
let extensionRoot: string = '';

export function activate(context: vscode.ExtensionContext) {
	console.log('🚀 Dev Voice Recorder extension ACTIVATED');

	// Store extension root so we can locate bundled assets like PowerShell scripts
	extensionRoot = context.extensionPath;
	vscode.window.showInformationMessage('Dev Voice Recorder is ready! Use Command Palette > Dev Voice: Open Recorder');

	const highlightDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(0, 122, 204, 0.25)',
		border: '1px solid #007acc',
		isWholeLine: true
	});

	const disposable = vscode.commands.registerCommand(
		'devvoice.openRecorder',
		() => {
			console.log('📝 openRecorder command triggered');
			vscode.window.showInformationMessage('Opening Dev Voice Recorder...');

			// Capture current editor info
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const selection = editor.selection;
				currentEditorInfo = {
					filepath: editor.document.fileName,
					filename: path.basename(editor.document.fileName),
					startLine: selection.start.line + 1,
					endLine: selection.end.line + 1,
					language: editor.document.languageId
				};
				console.log('📂 Editor info:', currentEditorInfo);

				// Highlight the selected range
				const range = new vscode.Range(selection.start.line, 0, selection.end.line, editor.document.lineAt(selection.end.line).text.length);
				editor.setDecorations(highlightDecoration, [range]);
			}

			const panel = vscode.window.createWebviewPanel(
				'devVoiceRecorder',
				'Dev Voice Recorder',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				}
			);
			currentPanel = panel;

			// Clean up when panel is closed
			panel.onDidDispose(() => {
				currentPanel = null;
				if (isRecording && recordingProcess) {
					console.log('Panel closed during recording, stopping...');
					isRecording = false;
					recordingProcess.kill();
					recordingProcess = null;
				}
			}, undefined, context.subscriptions);

			panel.webview.html = getWebviewContent(currentEditorInfo);

			// Handle messages from webview
			panel.webview.onDidReceiveMessage(
				message => {
					switch (message.command) {
						case 'start':
							startRecording(panel);
							break;
						case 'stop':
							stopRecording(panel);
							break;
						case 'listDevices':
							listAudioDevices(panel);
							break;
						case 'save':
							saveRecording(panel, message);
							break;
					}
				},
				undefined,
				context.subscriptions
			);
		}
	);

	context.subscriptions.push(disposable);

	// Register command to clear all recordings
	const clearRecordingsCommand = vscode.commands.registerCommand(
		'devvoice.clearAllRecordings',
		async () => {
			const answer = await vscode.window.showWarningMessage(
				'Are you sure you want to delete all recordings? This cannot be undone.',
				{ modal: true },
				'Delete All'
			);
			if (answer === 'Delete All') {
				clearAllRecordings();
			}
		}
	);
	context.subscriptions.push(clearRecordingsCommand);

	// Remove highlight when editor changes
	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			editor.setDecorations(highlightDecoration, []);
			loadAndDisplayAudioDecorations();
		}
	}, null, context.subscriptions);

	// Load decorations for current editor
	if (vscode.window.activeTextEditor) {
		loadAndDisplayAudioDecorations();
	}

	// Register hover provider for audio playback
	registerAudioHoverProvider(context);

	// Register command to play audio on hover click
	const playAudioCommand = vscode.commands.registerCommand(
		'devvoice.playAudio',
		(...args: any[]) => {
			console.log('Play audio command args:', args);
			// Parameters come as first argument in array when passed via markdown link
			let audioFile: string = '';
			let sourceFile: string = '';
			
			if (args.length === 1 && Array.isArray(args[0])) {
				[audioFile, sourceFile] = args[0];
			} else if (args.length >= 2) {
				[audioFile, sourceFile] = args;
			}
			
			console.log('Resolved:', { audioFile, sourceFile });
			if (audioFile && sourceFile) {
				playAudioRecording(audioFile, sourceFile);
			} else {
				vscode.window.showErrorMessage(`❌ Audio file or source file is missing: audioFile=${audioFile}, sourceFile=${sourceFile}`);
			}
		}
	);
	context.subscriptions.push(playAudioCommand);
}

function safePostMessage(panel: vscode.WebviewPanel, message: any) {
	try {
		panel.webview.postMessage(message);
	} catch (e) {
		console.warn('Could not post message - panel may be disposed:', e);
	}
}

function startRecording(panel: vscode.WebviewPanel) {
	try {
		console.log('🎙️ START RECORDING - initializing...');
		vscode.window.showInformationMessage('🎙️ Recording started - speaking now!');
		
		// Create temp file for audio
		const tempDir = path.join(os.tmpdir(), 'devvoice');
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
		audioFilePath = path.join(tempDir, `recording-${Date.now()}.wav`);
		console.log('📁 Audio file:', audioFilePath);

		// Use PowerShell script bundled with the extension (use extension root)
		const psScriptAbs = extensionRoot ? path.join(extensionRoot, 'record-audio.ps1') : path.join(__dirname, 'record-audio.ps1');
		console.log('📝 PowerShell script:', psScriptAbs);

		if (!fs.existsSync(psScriptAbs)) {
			const err = `PowerShell script not found: ${psScriptAbs}`;
			console.error('❌', err);
			vscode.window.showErrorMessage(err);
			safePostMessage(panel, { command: 'error', error: err });
			return;
		}

		recordingProcess = spawn('powershell', [
			'-NoProfile',
			'-ExecutionPolicy', 'Bypass',
			'-File', psScriptAbs,
			'-OutputFile', audioFilePath,
			'-Duration', '300'
		], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		if (!recordingProcess) {
			const err = 'Failed to spawn recorder process';
			console.error('❌', err);
			vscode.window.showErrorMessage(err);
			safePostMessage(panel, { command: 'error', error: err });
			return;
		}

		const pid = recordingProcess.pid || 'unknown';
		console.log(`✓ Process spawned with PID: ${pid}`);

		let stdoutData = '';
		let stderrData = '';

		recordingProcess.stdout?.on('data', (data: any) => {
			const text = data.toString();
			stdoutData += text;
			console.log('[RECORDER]', text.trim());
		});

		recordingProcess.stderr?.on('data', (data: any) => {
			const text = data.toString();
			stderrData += text;
			console.log('[ERROR]', text.trim());
		});

		recordingProcess.on('error', (err: any) => {
			const msg = `❌ Process error: ${err.message}`;
			console.error(msg);
			vscode.window.showErrorMessage(msg);
			safePostMessage(panel, { command: 'error', error: msg });
		});

		recordingProcess.on('exit', (code: any, signal: any) => {
			console.log(`✓ Recorder process exited - code: ${code}, signal: ${signal}`);
		});

		safePostMessage(panel, { command: 'status', message: '🎙️ Recording in progress... Speak clearly!' });
		isRecording = true;
	} catch (err: any) {
		const msg = `Exception: ${err.message}`;
		console.error('❌', msg);
		vscode.window.showErrorMessage(msg);
		safePostMessage(panel, { command: 'error', error: msg });
		isRecording = false;
	}
}

function listAudioDevices(panel: vscode.WebviewPanel) {
	try {
		console.log('Listing audio devices with ffmpeg...');
		safePostMessage(panel, { command: 'status', message: 'Scanning for audio devices...' });
		
		const args = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy', '-hide_banner'];
		
		const proc = spawn(ffmpegPath, args, {
			stdio: ['ignore', 'ignore', 'pipe'],
			windowsHide: true
		});

		let output = '';
		proc.stderr.on('data', (data: any) => {
			output += data.toString();
		});

		proc.on('exit', () => {
			console.log('=== FFmpeg device output START ===');
			console.log(output);
			console.log('=== FFmpeg device output END ===');
			
			// Parse device names from output - look for lines with "(audio)" at the end
			const lines = output.split('\n');
			const audioDevices: string[] = [];
			
			for (const line of lines) {
				console.log('Parsing line:', JSON.stringify(line));
				// Match pattern: "Device Name" (audio)
				const match = line.match(/"([^"]+)"\s*\(audio\)/);
				if (match) {
					console.log('  ✓ MATCHED! Device:', match[1]);
					if (match[1] && !match[1].startsWith('@')) {
						const deviceName = match[1].trim();
						if (deviceName && !audioDevices.includes(deviceName)) {
							audioDevices.push(deviceName);
							console.log('  → Added to list:', deviceName);
						}
					}
				}
			}
			
			console.log('Found audio devices:', audioDevices);
			console.log('Total devices found:', audioDevices.length);
			
			const deviceList = audioDevices.map(d => 'Device: ' + d).join('\n');
			safePostMessage(panel, { 
				command: 'deviceList', 
				devices: audioDevices,
				html: '<strong>Available Audio Devices:</strong><pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto;">' + 
					deviceList + '</pre><p><small>If you don\'t see your microphone, try recording anyway. Some devices use generic names.</small></p>'
			});
			
			updateStatusIfPanel(panel, 'Devices found. Try recording now!');
		});

		proc.on('error', (err: any) => {
			console.error('Error listing devices:', err);
			safePostMessage(panel, { 
				command: 'error', 
				error: 'Could not list devices: ' + err.message + '. Try recording with default microphone.' 
			});
		});
	} catch (err: any) {
		console.error('Error listing devices:', err);
		safePostMessage(panel, { command: 'error', error: 'Error: ' + err.message });
	}
}

function updateStatusIfPanel(panel: vscode.WebviewPanel, message: string) {
	safePostMessage(panel, { command: 'status', message });
}

function stopRecording(panel: vscode.WebviewPanel) {
	try {
		if (!isRecording) {
			console.log('⚠️ No recording in progress');
			safePostMessage(panel, { command: 'status', message: 'No recording in progress' });
			return;
		}

		console.log('⏹️ STOP RECORDING called');
		safePostMessage(panel, { command: 'status', message: '⏹️ Stopping recording...' });
		
		if (recordingProcess) {
			console.log('📤 Killing recorder process...');
			recordingProcess.kill();
			isRecording = false;
		}

		// Wait for file to be written - the recorder process saves the file
		let attempts = 0;
		const maxAttempts = 80; // 80 * 250ms = 20 seconds total
		const checkInterval = 250;

		const checkFileExists = () => {
			attempts++;
			if (attempts % 4 === 0) {
				console.log(`📊 File check ${attempts}/${maxAttempts}...`);
			}

			if (!fs.existsSync(audioFilePath)) {
				if (attempts >= maxAttempts) {
					console.error(`❌ File never created`);
					vscode.window.showErrorMessage('❌ Recording failed: file not created');
					safePostMessage(panel, { command: 'error', error: 'Audio file was not created' });
					return;
				}
				setTimeout(checkFileExists, checkInterval);
				return;
			}

			const stats = fs.statSync(audioFilePath);
			console.log(`✓ File found: ${stats.size} bytes`);

			if (stats.size < 200) {
				console.log(`⚠️ File too small, waiting...`);
				if (attempts >= maxAttempts) {
					console.error('❌ No audio data');
					vscode.window.showErrorMessage('❌ No audio data captured');
					safePostMessage(panel, { command: 'error', error: 'No audio data captured' });
					return;
				}
				setTimeout(checkFileExists, checkInterval);
				return;
			}

			// File looks good! Read and send
			console.log('✓ File ready, reading...');
			try {
				const audioData = fs.readFileSync(audioFilePath);
				console.log(`✓ Read ${audioData.length} bytes`);

				const base64Audio = audioData.toString('base64');
				console.log(`✓ Encoded to base64: ${base64Audio.length} chars`);

				safePostMessage(panel, { 
					command: 'audioReady', 
					audioData: base64Audio,
					mimeType: 'audio/wav'
				});
				
				vscode.window.showInformationMessage('✓ Recording ready to play!');
			} catch (readErr: any) {
				const msg = `Read error: ${readErr.message}`;
				console.error('❌', msg);
				safePostMessage(panel, { command: 'error', error: msg });
			}
		};

		// Wait a bit for process to exit, then check for file
		setTimeout(checkFileExists, 1500);

		recordingProcess = null;
		isRecording = false;
	} catch (err: any) {
		const msg = `Stop error: ${err.message}`;
		console.error('❌', msg);
		safePostMessage(panel, { command: 'error', error: msg });
	}
}

function saveRecording(panel: vscode.WebviewPanel, message: any) {
	try {
		console.log('💾 SAVE RECORDING called');
		const editorInfo = message.editorInfo;
		
		if (!editorInfo || !audioFilePath) {
			const err = 'No recording or editor info available';
			console.error('❌', err);
			safePostMessage(panel, { command: 'error', error: err });
			return;
		}

		// Get workspace root or use editor file directory as fallback
		let workspaceRoot = '';
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			workspaceRoot = workspaceFolders[0].uri.fsPath;
		} else if (editorInfo && editorInfo.filepath) {
			// Fallback: use the directory of the source file
			workspaceRoot = path.dirname(editorInfo.filepath);
		}

		if (!workspaceRoot) {
			const err = 'Could not determine save location';
			console.error('❌', err);
			safePostMessage(panel, { command: 'error', error: err });
			return;
		}
		const devvoiceDir = path.join(workspaceRoot, '.devvoice');
		const recordingsDir = path.join(devvoiceDir, 'recordings');
		const metadataFile = path.join(devvoiceDir, 'metadata.json');

		console.log('📁 Workspace root:', workspaceRoot);
		console.log('📁 DevVoice dir:', devvoiceDir);

		// Create directories if they don't exist
		if (!fs.existsSync(devvoiceDir)) {
			fs.mkdirSync(devvoiceDir, { recursive: true });
			console.log('✓ Created .devvoice directory');
		}
		if (!fs.existsSync(recordingsDir)) {
			fs.mkdirSync(recordingsDir, { recursive: true });
			console.log('✓ Created recordings directory');
		}

		// Generate unique recording ID
		const recordingId = `rec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const audioDestination = path.join(recordingsDir, `${recordingId}.wav`);

		// Copy audio file
		console.log('📝 Copying audio file...');
		const audioData = fs.readFileSync(audioFilePath);
		fs.writeFileSync(audioDestination, audioData);
		console.log(`✓ Audio saved: ${audioDestination}`);

		// Clean up temp file
		try {
			fs.unlinkSync(audioFilePath);
			console.log('✓ Cleaned up temp file');
		} catch (cleanupErr) {
			console.warn('Could not delete temp file:', cleanupErr);
		}

		// Create/update metadata
		let metadata: any = {};
		if (fs.existsSync(metadataFile)) {
			metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
			console.log('✓ Loaded existing metadata');
		}

		// Create recording entry
		const recording = {
			id: recordingId,
			audioFile: `recordings/${recordingId}.wav`,
			sourceFile: editorInfo.filepath,
			language: editorInfo.language,
			startLine: editorInfo.startLine,
			endLine: editorInfo.endLine,
			timestamp: new Date().toISOString(),
			duration: Math.round(fs.statSync(audioDestination).size / 44100 / 4) // Rough estimate
		};

		// Group recordings by file
		if (!metadata[editorInfo.filepath]) {
			metadata[editorInfo.filepath] = [];
		}
		metadata[editorInfo.filepath].push(recording);

		// Write metadata
		fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
		console.log('✓ Metadata saved');

		vscode.window.showInformationMessage(`✓ Recording saved! (Lines ${editorInfo.startLine}-${editorInfo.endLine})`);
		safePostMessage(panel, { command: 'recordingSaved', recordingId });

		// Reload decorations to show linked audio in editor
		loadAndDisplayAudioDecorations();

	} catch (err: any) {
		const msg = `Save error: ${err.message}`;
		console.error('❌', msg);
		vscode.window.showErrorMessage(msg);
		safePostMessage(panel, { command: 'error', error: msg });
	}
}

function getWebviewContent(editorInfo: any) {
	const fileInfo = editorInfo ? `${editorInfo.filename} (Lines ${editorInfo.startLine}-${editorInfo.endLine})` : 'No file selected';
	const hasSelection = editorInfo ? true : false;
    
	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<title>Dev Voice Recorder</title>
		<style>
			body {
				font-family: Arial, sans-serif;
				padding: 20px;
				background: #1e1e1e;
				color: #e0e0e0;
			}
			.header {
				margin-bottom: 20px;
				padding-bottom: 10px;
				border-bottom: 1px solid #444;
			}
			.file-info {
				background: #2d2d2d;
				padding: 10px;
				border-radius: 4px;
				margin: 10px 0;
				font-size: 12px;
				font-family: monospace;
			}
			button {
				padding: 10px 16px;
				margin-right: 10px;
				margin-top: 5px;
				font-size: 14px;
				cursor: pointer;
				background: #007acc;
				color: white;
				border: none;
				border-radius: 4px;
			}
			button:hover {
				background: #005a9e;
			}
			button:disabled {
				opacity: 0.5;
				cursor: not-allowed;
				background: #555;
			}
			button.secondary {
				background: #666;
			}
			button.secondary:hover {
				background: #777;
			}
			button.save {
				background: #28a745;
			}
			button.save:hover {
				background: #218838;
			}
			#status {
				padding: 10px;
				margin: 15px 0;
				background-color: #2d2d2d;
				border-radius: 4px;
				min-height: 20px;
				font-size: 12px;
				border-left: 3px solid #007acc;
			}
			#status.error {
				border-left-color: #f44747;
			}
			audio {
				display: block;
				margin-top: 20px;
				width: 100%;
			}
			#devices {
				margin-top: 15px;
				padding: 10px;
				background-color: #2d2d2d;
				border-radius: 4px;
				font-size: 12px;
				display: none;
			}
		</style>
	</head>
	<body>
		<div class="header">
			<h1>🎙️ Dev Voice Recorder</h1>
			<div class="file-info">
				📄 ${fileInfo}
			</div>
		</div>

		<div id="status">Ready to record</div>

		<div>
			<button id="start">Start Recording</button>
			<button id="stop" disabled>Stop Recording</button>
			<button id="listDevices" class="secondary">List Devices</button>
			<button id="save" class="save" disabled style="display: none;">💾 Save Recording</button>
		</div>

		<div id="devices"></div>

		<audio id="player" controls></audio>

		<script>
			const vscode = acquireVsCodeApi();
			const startBtn = document.getElementById('start');
			const stopBtn = document.getElementById('stop');
			const listDevicesBtn = document.getElementById('listDevices');
			const saveBtn = document.getElementById('save');
			const statusDiv = document.getElementById('status');
			const devicesDiv = document.getElementById('devices');
			const player = document.getElementById('player');

			let recordingReady = false;
			const editorInfo = ${JSON.stringify(editorInfo)};

			function updateStatus(message, isError = false) {
				statusDiv.textContent = message;
				statusDiv.classList.toggle('error', isError);
				console.log(message);
			}

			startBtn.onclick = () => {
				updateStatus('Starting recording...');
				startBtn.disabled = true;
				stopBtn.disabled = false;
				recordingReady = false;
				saveBtn.style.display = 'none';
				saveBtn.disabled = true;
				vscode.postMessage({ command: 'start' });
			};

			stopBtn.onclick = () => {
				updateStatus('Stopping recording...');
				startBtn.disabled = true;
				stopBtn.disabled = true;
				vscode.postMessage({ command: 'stop' });
			};

			listDevicesBtn.onclick = () => {
				updateStatus('Retrieving audio devices...');
				vscode.postMessage({ command: 'listDevices' });
			};

			saveBtn.onclick = () => {
				if (!editorInfo) {
					updateStatus('Error: No file selected', true);
					return;
				}
				updateStatus('Saving recording...');
				saveBtn.disabled = true;
				vscode.postMessage({ 
					command: 'save',
					editorInfo: editorInfo
				});
			};

			// Listen for messages from extension
			window.addEventListener('message', event => {
				const message = event.data;
				console.log('Received message:', message.command);
				switch (message.command) {
					case 'status':
						updateStatus(message.message);
						break;
					case 'deviceList':
						devicesDiv.style.display = 'block';
						if (message.devices && message.devices.length === 0) {
							devicesDiv.innerHTML = '<strong>No audio devices found</strong>';
						} else if (message.html) {
							devicesDiv.innerHTML = message.html;
						} else {
							devicesDiv.innerHTML = '<strong>Available Audio Devices:</strong><br>' + 
								(message.devices || []).map(d => '• ' + d).join('<br>');
						}
						break;
					case 'audioReady':
						try {
							console.log('Audio data received, size:', message.audioData.length);
							updateStatus('Recording complete - ready to save');
							const binaryString = atob(message.audioData);
							const bytes = new Uint8Array(binaryString.length);
							for (let i = 0; i < binaryString.length; i++) {
								bytes[i] = binaryString.charCodeAt(i);
							}
							const audioBlob = new Blob([bytes], { type: message.mimeType });
							const objectUrl = URL.createObjectURL(audioBlob);
							player.src = objectUrl;
							player.load();
							
							// Show save button if editor info exists
							if (editorInfo) {
								saveBtn.style.display = 'inline-block';
								saveBtn.disabled = false;
							}
							
							recordingReady = true;
							startBtn.disabled = false;
							stopBtn.disabled = true;
							
							// Try to play automatically
							player.play().catch(() => {
								updateStatus('Audio ready. Click play or Save Recording.');
							});
						} catch (err) {
							console.error('Error processing audio:', err);
							updateStatus('Error processing audio: ' + err.message, true);
						}
						break;
					case 'recordingSaved':
						updateStatus('✓ Recording saved successfully!');
						startBtn.disabled = false;
						saveBtn.disabled = false;
						break;
					case 'error':
						updateStatus('Error: ' + message.error, true);
						startBtn.disabled = false;
						stopBtn.disabled = true;
						saveBtn.disabled = true;
						break;
				}
			});
		</script>
	</body>
	</html>
	`;
}

// Load and display audio decorations for linked code
function loadAndDisplayAudioDecorations() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const filePath = editor.document.fileName;
	
	// Find .devvoice directory - check workspace root or file directory
	let workspaceRoot = '';
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		workspaceRoot = workspaceFolders[0].uri.fsPath;
	} else {
		workspaceRoot = path.dirname(filePath);
	}

	const metadataFile = path.join(workspaceRoot, '.devvoice', 'metadata.json');
	
	if (!fs.existsSync(metadataFile)) {
		console.log('📋 No metadata found');
		return;
	}

	try {
		audioMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
		
		// Get recordings for current file
		const fileMetadata = audioMetadata[filePath];
		if (!fileMetadata || fileMetadata.length === 0) {
			console.log('📋 No recordings for this file');
			return;
		}

		// Create decorations for each recording
		const decorationRanges: vscode.Range[] = [];
		fileMetadata.forEach((recording: any) => {
			const startLine = recording.startLine - 1;
			const endLine = recording.endLine - 1;
			decorationRanges.push(new vscode.Range(startLine, 0, endLine, 999));
		});

		// Apply decorations
		if (!audioDecoration) {
			audioDecoration = vscode.window.createTextEditorDecorationType({
				backgroundColor: 'rgba(76, 175, 80, 0.15)',
				border: '1px dashed #4caf50',
				isWholeLine: true,
				overviewRulerColor: '#4caf50'
			});
		}

		editor.setDecorations(audioDecoration, decorationRanges);
		console.log(`✓ Applied decorations to ${decorationRanges.length} ranges with audio`);
	} catch (err) {
		console.error('Error loading metadata:', err);
	}
}

// Register hover provider for playing audio
function registerAudioHoverProvider(context: vscode.ExtensionContext) {
	if (hoverProvider) {
		return;
	}

	hoverProvider = vscode.languages.registerHoverProvider('*', {
		provideHover(document, position) {
			// Check if this line has audio metadata
			const filePath = document.fileName;
			const fileMetadata = audioMetadata[filePath];
			
			if (!fileMetadata) {
				return null;
			}

			const lineNum = position.line + 1;
			const recording = fileMetadata.find((r: any) => 
				lineNum >= r.startLine && lineNum <= r.endLine
			);

			if (!recording) {
				return null;
			}

			// Create hover with audio info
		// Pass parameters as JSON array in command link
		const params = encodeURIComponent(JSON.stringify([recording.audioFile, document.fileName]));
		const markdown = new vscode.MarkdownString(
			`🎙️ **Audio Recording** 
\n\nLines: ${recording.startLine}-${recording.endLine}
\n\nDuration: ${recording.duration || '?'}s
\n\n[▶️ Play Audio](command:devvoice.playAudio?${params})`
		);
		markdown.isTrusted = true;

			return new vscode.Hover(markdown);
		}
	});

	context.subscriptions.push(hoverProvider);
}

// Play audio recording
function playAudioRecording(audioFile: string, sourceFile: string) {
	try {
		// Find .devvoice directory
		let workspaceRoot = '';
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			workspaceRoot = workspaceFolders[0].uri.fsPath;
		} else {
			workspaceRoot = path.dirname(sourceFile);
		}

		const audioPath = path.join(workspaceRoot, '.devvoice', audioFile);
		
		if (!fs.existsSync(audioPath)) {
			vscode.window.showErrorMessage(`❌ Audio file not found: ${audioPath}`);
			return;
		}

		// Clean up previous playback process if still running
		if (audioPlayback) {
			try {
				audioPlayback.kill();
			} catch (e) {
				// Process already terminated
			}
		}

		// Open in default audio player, storing the process reference
		const { exec } = require('child_process');
		if (process.platform === 'win32') {
			audioPlayback = exec(`start "" "${audioPath}"`);
		} else if (process.platform === 'darwin') {
			audioPlayback = exec(`open "${audioPath}"`);
		} else {
			audioPlayback = exec(`xdg-open "${audioPath}"`);
		}

		vscode.window.showInformationMessage('▶️ Playing audio...');
	} catch (err: any) {
		vscode.window.showErrorMessage(`Error playing audio: ${err.message}`);
	}
}

// Clear all saved recordings
function clearAllRecordings() {
	try {
		console.log('🗑️ Clearing all recordings...');
		
		// Find .devvoice directory
		let workspaceRoot = '';
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			workspaceRoot = workspaceFolders[0].uri.fsPath;
		} else if (vscode.window.activeTextEditor) {
			// Fallback: use the directory of the active file
			workspaceRoot = path.dirname(vscode.window.activeTextEditor.document.fileName);
		}

		if (!workspaceRoot) {
			vscode.window.showErrorMessage('❌ Could not determine workspace root. Please open a file in your workspace first.');
			return;
		}

		const devvoiceDir = path.join(workspaceRoot, '.devvoice');
		const recordingsDir = path.join(devvoiceDir, 'recordings');
		const metadataFile = path.join(devvoiceDir, 'metadata.json');

		// Delete all audio files in recordings directory
		if (fs.existsSync(recordingsDir)) {
			const files = fs.readdirSync(recordingsDir);
			for (const file of files) {
				const filePath = path.join(recordingsDir, file);
				try {
					fs.unlinkSync(filePath);
					console.log(`✓ Deleted: ${file}`);
				} catch (err) {
					console.warn(`⚠️ Could not delete ${file}:`, err);
				}
			}
			// Delete the recordings directory itself if empty
			try {
				fs.rmdirSync(recordingsDir);
				console.log('✓ Removed recordings directory');
			} catch (err) {
				// Directory may not be empty or have other issues
			}
		}

		// Delete metadata file
		if (fs.existsSync(metadataFile)) {
			try {
				fs.unlinkSync(metadataFile);
				console.log('✓ Deleted metadata.json');
				audioMetadata = {}; // Clear in-memory metadata
			} catch (err) {
				console.warn('⚠️ Could not delete metadata.json:', err);
			}
		}

		// Reload decorations to clear hover hints
		loadAndDisplayAudioDecorations();

		vscode.window.showInformationMessage('✓ All recordings cleared successfully!');
		console.log('✓ All recordings cleared');
	} catch (err: any) {
		const msg = `Error clearing recordings: ${err.message}`;
		console.error('❌', msg);
		vscode.window.showErrorMessage(msg);
	}
}

export function deactivate() {
	// Kill any active recording process
	if (recordingProcess && isRecording) {
		console.log('Deactivating: Killing recording process');
		recordingProcess.kill();
		recordingProcess = null;
		isRecording = false;
	}
	
	// Kill any audio playback process
	if (audioPlayback) {
		try {
			audioPlayback.kill();
		} catch (e) {
			// Process already terminated
		}
		audioPlayback = null;
	}

	if (hoverProvider) {
		hoverProvider.dispose();
	}
	if (audioDecoration) {
		audioDecoration.dispose();
	}
}

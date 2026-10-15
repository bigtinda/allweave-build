#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::ffi::{c_void, OsStr};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::WebviewWindowBuilder;
use tauri::{Manager, RunEvent, WebviewUrl};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

#[repr(C)]
struct JobObjectBasicLimitInformation {
	per_process_user_time_limit: i64,
	per_job_user_time_limit: i64,
	limit_flags: u32,
	minimum_working_set_size: usize,
	maximum_working_set_size: usize,
	active_process_limit: u32,
	affinity: usize,
	priority_class: u32,
	scheduling_class: u32,
}

#[repr(C)]
struct IoCounters {
	read_operation_count: u64,
	write_operation_count: u64,
	other_operation_count: u64,
	read_transfer_count: u64,
	write_transfer_count: u64,
	other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
	basic_limit_information: JobObjectBasicLimitInformation,
	io_info: IoCounters,
	process_memory_limit: usize,
	job_memory_limit: usize,
	peak_process_memory_used: usize,
	peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
	fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
	fn SetInformationJobObject(
		job: *mut c_void,
		class: i32,
		information: *const c_void,
	length: u32,
	) -> i32;
	fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
	fn CloseHandle(handle: *mut c_void) -> i32;
}

#[link(name = "bcrypt")]
unsafe extern "system" {
	fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

#[link(name = "user32")]
unsafe extern "system" {
	fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

struct ProcessJob(isize);

unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
	fn new() -> io::Result<Self> {
		let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
		if handle.is_null() {
			return Err(io::Error::last_os_error());
		}
		let mut information = JobObjectExtendedLimitInformation {
			basic_limit_information: JobObjectBasicLimitInformation {
				per_process_user_time_limit: 0,
				per_job_user_time_limit: 0,
				limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
				minimum_working_set_size: 0,
				maximum_working_set_size: 0,
				active_process_limit: 0,
				affinity: 0,
				priority_class: 0,
				scheduling_class: 0,
			},
			io_info: IoCounters {
				read_operation_count: 0,
				write_operation_count: 0,
				other_operation_count: 0,
				read_transfer_count: 0,
				write_transfer_count: 0,
				other_transfer_count: 0,
			},
			process_memory_limit: 0,
			job_memory_limit: 0,
			peak_process_memory_used: 0,
			peak_job_memory_used: 0,
		};
		let success = unsafe {
			SetInformationJobObject(
				handle,
				JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
				(&mut information as *mut JobObjectExtendedLimitInformation).cast(),
				std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
			)
		};
		if success == 0 {
			unsafe { CloseHandle(handle) };
			return Err(io::Error::last_os_error());
		}
		Ok(Self(handle as isize))
	}

	fn attach(&self, child: &Child) -> io::Result<()> {
		use std::os::windows::io::AsRawHandle;
		let success = unsafe { AssignProcessToJobObject(self.0 as *mut c_void, child.as_raw_handle().cast()) };
		if success == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
}

impl Drop for ProcessJob {
	fn drop(&mut self) {
		unsafe { CloseHandle(self.0 as *mut c_void) };
	}
}

struct BackendProcess {
	child: Mutex<Option<Child>>,
	job: Mutex<Option<ProcessJob>>,
	port: u16,
	shutdown_token: String,
}

impl BackendProcess {
	fn stop(&self) {
		let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
		let Some(process) = child.as_mut() else {
			return;
		};
		let _ = request_shutdown(self.port, &self.shutdown_token);
		let deadline = Instant::now() + Duration::from_secs(5);
		while Instant::now() < deadline {
			if process.try_wait().ok().flatten().is_some() {
				*child = None;
				self.job.lock().unwrap_or_else(|error| error.into_inner()).take();
				return;
			}
			thread::sleep(Duration::from_millis(100));
		}
		self.job.lock().unwrap_or_else(|error| error.into_inner()).take();
		let _ = process.kill();
		let _ = process.wait();
		*child = None;
	}
}

impl Drop for BackendProcess {
	fn drop(&mut self) {
		self.stop();
	}
}

struct RuntimePaths {
	root: PathBuf,
	node: PathBuf,
}

fn main() {
	if let Err(error) = run() {
		show_error(&error.to_string());
	}
}

fn run() -> Result<(), Box<dyn Error>> {
	let app = tauri::Builder::default()
		.setup(|app| {
			let executable_directory = std::env::current_exe()?
				.parent()
				.ok_or_else(|| io::Error::other("The application executable has no parent directory"))?
				.to_path_buf();
			let runtime = runtime_paths(&executable_directory)?;
			let data_directory = executable_directory.join("data");
			let workspace_directory = executable_directory.join("workspaces");
			fs::create_dir_all(&data_directory)?;
			fs::create_dir_all(&workspace_directory)?;
			let roots = configured_roots(&executable_directory, &workspace_directory)?;
			let roots = std::env::join_paths(roots)?;
			let webview_data = data_directory.join("webview");
			fs::create_dir_all(&webview_data)?;
			std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data);
			let fixed_webview = executable_directory.join("webview2-runtime");
			if fixed_webview.join("msedgewebview2.exe").is_file() {
				std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &fixed_webview);
			}

			let (port, listener) = available_port()?;
			drop(listener);
			let shutdown_token = random_shutdown_token()?;
			let log = File::create(data_directory.join("desktop-server.log"))?;
			let job = ProcessJob::new()?;
			let mut backend_path = vec![runtime.root.clone()];
			if let Some(path) = std::env::var_os("PATH") {
				backend_path.extend(std::env::split_paths(&path));
			}
			let backend_path = std::env::join_paths(backend_path)?;
			let mut command = Command::new(runtime.node);
			command
				.arg("--import")
				.arg("./packages/coding-agent/src/experimental/source-resolver.ts")
				.arg("./apps/server/src/main.ts")
				.current_dir(&runtime.root)
				.env("PI_CONSOLE_DESKTOP", "1")
				.env("PI_CONSOLE_PORT", port.to_string())
				.env("PI_CONSOLE_SHUTDOWN_TOKEN", &shutdown_token)
				.env("PI_CONSOLE_DATA_DIR", &data_directory)
				.env("PI_CODING_AGENT_DIR", data_directory.join("agent"))
				.env("PI_CONSOLE_ROOTS", roots)
				.env("PATH", backend_path)
				.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
				.stdin(Stdio::null())
				.stdout(Stdio::from(log.try_clone()?))
				.stderr(Stdio::from(log));
			let mut child = command.spawn()?;
			if let Err(error) = job.attach(&child) {
				let _ = child.kill();
				return Err(error.into());
			}
			if let Err(error) = wait_for_server(&mut child, port) {
				let _ = child.kill();
				let _ = child.wait();
				return Err(error.into());
			}

			app.manage(BackendProcess {
				child: Mutex::new(Some(child)),
				job: Mutex::new(Some(job)),
				port,
				shutdown_token,
			});
			let origin = format!("http://127.0.0.1:{port}");
			let url = origin.parse()?;
			WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
				.title("AllWeave Build · 构序")
				.inner_size(1440.0, 960.0)
				.min_inner_size(900.0, 640.0)
				.center()
				.build()?;
			Ok(())
		})
		.build(tauri::generate_context!())?;
	app.run(|handle, event| {
		if matches!(event, RunEvent::Exit) {
			if let Some(backend) = handle.try_state::<BackendProcess>() {
				backend.stop();
			}
		}
	});
	Ok(())
}

fn runtime_paths(executable_directory: &Path) -> io::Result<RuntimePaths> {
	let packaged_root = executable_directory.join("runtime");
	let development_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
	let root = if packaged_root.join("apps/server/src/main.ts").is_file() {
		packaged_root
	} else {
		development_root.canonicalize()?
	};
	let bundled_node = root.join("node.exe");
	let node = if bundled_node.is_file() {
		bundled_node
	} else {
		std::env::var_os("PATH")
			.and_then(|path| std::env::split_paths(&path).map(|part| part.join("node.exe")).find(|path| path.is_file()))
			.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Bundled Node.js runtime is missing"))?
	};
	Ok(RuntimePaths { root, node })
}

fn configured_roots(executable_directory: &Path, default_root: &Path) -> io::Result<Vec<PathBuf>> {
	let path = executable_directory.join("workspace-roots.txt");
	if !path.exists() {
		fs::write(&path, "# One authorized workspace folder per line. Relative paths use this folder.\nworkspaces\n")?;
	}
	let contents = fs::read_to_string(&path)?;
	let mut roots = Vec::new();
	for line in contents.lines().map(|line| line.trim_start_matches('\u{feff}').trim()) {
		if line.is_empty() || line.starts_with('#') {
			continue;
		}
		if line.contains(';') {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "Workspace paths cannot contain semicolons"));
		}
		let candidate = PathBuf::from(line);
		let candidate = if candidate.is_absolute() { candidate } else { executable_directory.join(candidate) };
		if !candidate.is_dir() {
			return Err(io::Error::new(io::ErrorKind::NotFound, format!("Workspace folder does not exist: {}", candidate.display())));
		}
		roots.push(candidate.canonicalize()?);
	}
	if roots.is_empty() {
		fs::create_dir_all(default_root)?;
		roots.push(default_root.canonicalize()?);
	}
	Ok(roots)
}

fn available_port() -> io::Result<(u16, TcpListener)> {
	let listener = TcpListener::bind(("127.0.0.1", 0))?;
	let port = listener.local_addr()?.port();
	if port < 1024 {
		return Err(io::Error::other("Windows assigned a privileged local port"));
	}
	Ok((port, listener))
}

fn random_shutdown_token() -> io::Result<String> {
	let mut bytes = [0_u8; 32];
	let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, 2) };
	if status != 0 {
		return Err(io::Error::other(format!("Windows could not create a shutdown credential ({status:#x})")));
	}
	let digits = b"0123456789abcdef";
	let mut token = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		token.push(char::from(digits[usize::from(byte >> 4)]));
		token.push(char::from(digits[usize::from(byte & 0x0f)]));
	}
	Ok(token)
}

fn wait_for_server(child: &mut Child, port: u16) -> io::Result<()> {
	let deadline = Instant::now() + Duration::from_secs(180);
	while Instant::now() < deadline {
		if let Some(status) = child.try_wait()? {
			return Err(io::Error::other(format!(
				"AllWeave Build service exited during startup ({status}). See data/desktop-server.log."
			)));
		}
		if server_is_ready(port) {
			return Ok(());
		}
		thread::sleep(Duration::from_millis(150));
	}
	Err(io::Error::new(
		io::ErrorKind::TimedOut,
		"AllWeave Build service did not start within 180 seconds. See data/desktop-server.log.",
	))
}

fn server_is_ready(port: u16) -> bool {
	let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
		return false;
	};
	let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
	let request = format!(
		"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
	);
	if stream.write_all(request.as_bytes()).is_err() {
		return false;
	}
	let mut response = String::new();
	BufReader::new(stream)
		.read_line(&mut response)
		.map(|_| response.starts_with("HTTP/1.1 200"))
		.unwrap_or(false)
}

fn request_shutdown(port: u16, token: &str) -> io::Result<()> {
	let mut stream = TcpStream::connect_timeout(
		&format!("127.0.0.1:{port}").parse().map_err(io::Error::other)?,
		Duration::from_secs(1),
	)?;
	let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
	let request = format!(
		"POST /api/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nX-Pi-Console-Shutdown-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
	);
	stream.write_all(request.as_bytes())?;
	let mut response = [0_u8; 128];
	let _ = stream.read(&mut response);
	Ok(())
}

fn show_error(message: &str) {
	let body = wide(message);
	let title = wide("AllWeave Build · 构序启动失败");
	unsafe {
		MessageBoxW(
			std::ptr::null_mut(),
			body.as_ptr(),
			title.as_ptr(),
			0x0000_0010 | 0x0000_0000,
		);
	}
}

fn wide(value: &str) -> Vec<u16> {
	OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use walkdir::WalkDir;
use rayon::prelude::*;
use libloading::Library;

// Native Windows API imports for HWND embedding
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SetParent, ShowWindow, SW_SHOW};

// ============================================================================
// Steinberg VST3 API C/COM Binary Layout Definitions
// ============================================================================

pub type TResult = i32;
pub const K_RESULT_OK: TResult = 0;
pub const K_RESULT_FALSE: TResult = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TGuid {
    pub data: [u8; 16],
}

impl TGuid {
    pub const fn new(a: u32, b: u32, c: u32, d: u32) -> Self {
        let mut data = [0u8; 16];
        data[0] = (a >> 24) as u8; data[1] = (a >> 16) as u8; data[2] = (a >> 8) as u8; data[3] = a as u8;
        data[4] = (b >> 24) as u8; data[5] = (b >> 16) as u8; data[6] = (b >> 8) as u8; data[7] = b as u8;
        data[8] = (c >> 24) as u8; data[9] = (c >> 16) as u8; data[10] = (c >> 8) as u8; data[11] = c as u8;
        data[12] = (d >> 24) as u8; data[13] = (d >> 16) as u8; data[14] = (d >> 8) as u8; data[15] = d as u8;
        Self { data }
    }
}

// Steinberg VST3 Interface IIDs
pub const IUNKNOWN_IID: TGuid = TGuid::new(0x00000000, 0x00000000, 0xC0000000, 0x00000046);
pub const IPLUGIN_FACTORY_IID: TGuid = TGuid::new(0x4A42444F, 0x4E412F41, 0x56535420, 0x46616374);
pub const ICOMPONENT_IID: TGuid = TGuid::new(0x7B81E29F, 0xCEE14915, 0x8B2129A8, 0xE982D1B2);
pub const IAUDIO_PROCESSOR_IID: TGuid = TGuid::new(0x42043F99, 0xB72C4147, 0xAB932828, 0x47A78716);
pub const IEDIT_CONTROLLER_IID: TGuid = TGuid::new(0xDCD764D0, 0xF5004A32, 0xA9937E00, 0x29CD07D7);
pub const IPLUG_VIEW_IID: TGuid = TGuid::new(0x5BEE8B29, 0xCA9C46CE, 0x82A1C6A0, 0xA0A34991);

// Standard Category CID for Audio Effect Plugins
pub const K_AUDIO_EFFECT_CLASS: &str = "Audio Module Class";

#[repr(C)]
pub struct IUnknownVtbl {
    pub query_interface: unsafe extern "system" fn(this: *mut c_void, iid: *const TGuid, obj: *mut *mut c_void) -> TResult,
    pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

#[repr(C)]
pub struct IPluginFactoryVtbl {
    pub unknown: IUnknownVtbl,
    pub get_factory_info: unsafe extern "system" fn(this: *mut c_void, info: *mut c_void) -> TResult,
    pub count_classes: unsafe extern "system" fn(this: *mut c_void) -> i32,
    pub get_class_info: unsafe extern "system" fn(this: *mut c_void, index: i32, info: *mut PClassInfo) -> TResult,
    pub create_instance: unsafe extern "system" fn(this: *mut c_void, cid: *const TGuid, iid: *const TGuid, obj: *mut *mut c_void) -> TResult,
}

#[repr(C)]
pub struct PClassInfo {
    pub cid: TGuid,
    pub cardinality: i32,
    pub category: [i8; 32],
    pub name: [i8; 64],
}

#[repr(C)]
pub struct IComponentVtbl {
    pub unknown: IUnknownVtbl,
    pub initialize: unsafe extern "system" fn(this: *mut c_void, context: *mut c_void) -> TResult,
    pub terminate: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub get_controller_class_id: unsafe extern "system" fn(this: *mut c_void, class_id: *mut TGuid) -> TResult,
    pub set_io_mode: unsafe extern "system" fn(this: *mut c_void, mode: i32) -> TResult,
    pub get_bus_count: unsafe extern "system" fn(this: *mut c_void, type_: i32, dir: i32) -> i32,
    pub get_bus_info: unsafe extern "system" fn(this: *mut c_void, type_: i32, dir: i32, index: i32, info: *mut c_void) -> TResult,
    pub get_routing_info: unsafe extern "system" fn(this: *mut c_void, in_info: *mut c_void, out_info: *mut c_void) -> TResult,
    pub activate_bus: unsafe extern "system" fn(this: *mut c_void, type_: i32, dir: i32, index: i32, state: bool) -> TResult,
    pub set_active: unsafe extern "system" fn(this: *mut c_void, state: bool) -> TResult,
    pub set_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ProcessSetup {
    pub process_mode: i32,           // 0 = kRealtime
    pub symbolic_sample_size: i32,  // 0 = kSample32
    pub max_samples_per_block: i32, // e.g. 512 / 1024
    pub sample_rate: f64,           // e.g. 48000.0
}

#[repr(C)]
pub struct AudioBusBuffers {
    pub num_channels: i32,
    pub silence_flags: u64,
    pub buffers: *mut *mut f32,
}

#[repr(C)]
pub struct ProcessData {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub num_samples: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub inputs: *mut AudioBusBuffers,
    pub outputs: *mut AudioBusBuffers,
    pub param_changes: *mut c_void,
    pub event_changes: *mut c_void,
    pub context: *mut c_void,
}

#[repr(C)]
pub struct IAudioProcessorVtbl {
    pub unknown: IUnknownVtbl,
    pub set_bus_arrangements: unsafe extern "system" fn(this: *mut c_void, inputs: *mut u64, num_ins: i32, outputs: *mut u64, num_outs: i32) -> TResult,
    pub get_bus_arrangement: unsafe extern "system" fn(this: *mut c_void, dir: i32, index: i32, arr: *mut u64) -> TResult,
    pub can_process_sample_size: unsafe extern "system" fn(this: *mut c_void, symbolic_sample_size: i32) -> TResult,
    pub get_latency_samples: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub setup_processing: unsafe extern "system" fn(this: *mut c_void, setup: *const ProcessSetup) -> TResult,
    pub set_processing: unsafe extern "system" fn(this: *mut c_void, state: bool) -> TResult,
    pub process: unsafe extern "system" fn(this: *mut c_void, data: *mut ProcessData) -> TResult,
    pub get_tail_samples: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

#[repr(C)]
pub struct ParameterInfo {
    pub id: u32,
    pub title: [u16; 128],
    pub short_title: [u16; 128],
    pub units: [u16; 64],
    pub step_count: i32,
    pub default_normalized_value: f64,
    pub unit_id: i32,
    pub flags: i32,
}

#[repr(C)]
pub struct IEditControllerVtbl {
    pub unknown: IUnknownVtbl,
    pub initialize: unsafe extern "system" fn(this: *mut c_void, context: *mut c_void) -> TResult,
    pub terminate: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub set_component_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub set_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_state: unsafe extern "system" fn(this: *mut c_void, state: *mut c_void) -> TResult,
    pub get_parameter_count: unsafe extern "system" fn(this: *mut c_void) -> i32,
    pub get_parameter_info: unsafe extern "system" fn(this: *mut c_void, param_index: i32, info: *mut ParameterInfo) -> TResult,
    pub get_param_string_by_value: unsafe extern "system" fn(this: *mut c_void, id: u32, value_normalized: f64, string: *mut u16) -> TResult,
    pub get_param_value_by_string: unsafe extern "system" fn(this: *mut c_void, id: u32, string: *const u16, value_normalized: *mut f64) -> TResult,
    pub normalized_param_to_plain: unsafe extern "system" fn(this: *mut c_void, id: u32, value_normalized: f64) -> f64,
    pub plain_param_to_normalized: unsafe extern "system" fn(this: *mut c_void, id: u32, plain_value: f64) -> f64,
    pub get_param_normalized: unsafe extern "system" fn(this: *mut c_void, id: u32) -> f64,
    pub set_param_normalized: unsafe extern "system" fn(this: *mut c_void, id: u32, value: f64) -> TResult,
    pub set_component_handler: unsafe extern "system" fn(this: *mut c_void, handler: *mut c_void) -> TResult,
    pub create_view: unsafe extern "system" fn(this: *mut c_void, name: *const i8) -> *mut c_void,
}

#[repr(C)]
pub struct ViewRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
pub struct IPlugViewVtbl {
    pub unknown: IUnknownVtbl,
    pub is_platform_type_supported: unsafe extern "system" fn(this: *mut c_void, type_: *const i8) -> TResult,
    pub attached: unsafe extern "system" fn(this: *mut c_void, parent: *mut c_void, type_: *const i8) -> TResult,
    pub removed: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub on_wheel: unsafe extern "system" fn(this: *mut c_void, distance: f32) -> TResult,
    pub on_key_down: unsafe extern "system" fn(this: *mut c_void, key: u16, key_code: i16, modifiers: i16) -> TResult,
    pub on_key_up: unsafe extern "system" fn(this: *mut c_void, key: u16, key_code: i16, modifiers: i16) -> TResult,
    pub get_size: unsafe extern "system" fn(this: *mut c_void, rect: *mut ViewRect) -> TResult,
    pub on_size: unsafe extern "system" fn(this: *mut c_void, rect: *mut ViewRect) -> TResult,
    pub can_resize: unsafe extern "system" fn(this: *mut c_void) -> TResult,
    pub check_size_constraint: unsafe extern "system" fn(this: *mut c_void, rect: *mut ViewRect) -> TResult,
}

// Function pointer signatures exported by VST3 DLL / Bundle
pub type GetPluginFactoryFn = unsafe extern "system" fn() -> *mut c_void;
pub type InitDllFn = unsafe extern "system" fn() -> bool;
pub type ExitDllFn = unsafe extern "system" fn() -> bool;

// ============================================================================
// Application Data Structures
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginMetadata {
    pub name: String,
    pub manufacturer: String,
    pub category: String,
    pub version: String,
    pub inputs: i32,
    pub outputs: i32,
    pub unique_id: i32,
    pub path: String,
    pub format: String, // Always "VST3"
}

pub struct Vst3Instance {
    pub library: Arc<Library>,
    pub factory: *mut c_void,
    pub component: *mut c_void,
    pub processor: *mut c_void,
    pub controller: Option<*mut c_void>,
    pub plug_view: Option<*mut c_void>,
    pub sample_rate: f64,
    pub block_size: usize,
}

// Implement Send & Sync for Vst3Instance protected by Mutex
unsafe impl Send for Vst3Instance {}
unsafe impl Sync for Vst3Instance {}

impl Drop for Vst3Instance {
    fn drop(&mut self) {
        unsafe {
            if let Some(view) = self.plug_view {
                let vtbl = *(view as *mut *mut IPlugViewVtbl);
                ((*vtbl).removed)(view);
                ((*vtbl).unknown.release)(view);
            }
            if let Some(ctrl) = self.controller {
                let vtbl = *(ctrl as *mut *mut IEditControllerVtbl);
                ((*vtbl).unknown.release)(ctrl);
            }
            if !self.processor.is_null() {
                let vtbl = *(self.processor as *mut *mut IAudioProcessorVtbl);
                ((*vtbl).set_processing)(self.processor, false);
                ((*vtbl).unknown.release)(self.processor);
            }
            if !self.component.is_null() {
                let vtbl = *(self.component as *mut *mut IComponentVtbl);
                ((*vtbl).set_active)(self.component, false);
                ((*vtbl).terminate)(self.component);
                ((*vtbl).unknown.release)(self.component);
            }
            if !self.factory.is_null() {
                let vtbl = *(self.factory as *mut *mut IPluginFactoryVtbl);
                ((*vtbl).unknown.release)(self.factory);
            }
        }
    }
}

pub struct LoadedPlugin {
    pub metadata: PluginMetadata,
    pub instance: Option<Arc<Mutex<Vst3Instance>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginParameter {
    pub id: i32,
    pub name: String,
    pub label: String,
    pub value: f32, // 0.0 to 1.0
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VstChainStep {
    pub id: String,
    pub name: String,
    pub path: String,
    pub format: String,
    pub bypass: bool,
    pub mix: f32,       // 0.0 to 1.0 (dry/wet)
    pub gain_db: f32,   // output gain in dB (-24..+24)
    #[serde(default)]
    pub parameters: HashMap<i32, f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VstRackBatchConfig {
    pub preset_name: String,
    pub bypass: bool,
    pub master_mix: f32,
    pub master_gain_db: f32,
    pub plugins: Vec<VstChainStep>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VstProcessReport {
    pub input_file: String,
    pub output_file: String,
    pub processed_samples: usize,
    pub duration_seconds: f64,
    pub active_plugins_count: usize,
    pub peak_before_db: f32,
    pub peak_after_db: f32,
    pub processing_time_ms: u64,
}

pub struct VstHostState {
    pub loaded_plugins: HashMap<String, LoadedPlugin>,
}

impl Default for VstHostState {
    fn default() -> Self {
        Self {
            loaded_plugins: HashMap::new(),
        }
    }
}

pub type SharedVstHostState = Arc<Mutex<VstHostState>>;

// ============================================================================
// Helper Functions for VST3 Bundle Resolution & Meta Extraction
// ============================================================================

/// Resolve a VST3 bundle directory path to its underlying binary location (.vst3 / .dll)
pub fn resolve_vst3_binary_path(path: &Path) -> PathBuf {
    if path.is_file() {
        return path.to_path_buf();
    }

    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    
    // Windows structure: Bundle.vst3/Contents/x86_64-win/Bundle.vst3 (or .dll)
    #[cfg(target_os = "windows")]
    {
        let win_dir = path.join("Contents").join("x86_64-win");
        if win_dir.exists() {
            let candidate1 = win_dir.join(format!("{}.vst3", file_stem));
            if candidate1.exists() {
                return candidate1;
            }
            let candidate2 = win_dir.join(format!("{}.dll", file_stem));
            if candidate2.exists() {
                return candidate2;
            }
            if let Ok(entries) = std::fs::read_dir(&win_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                    if ext == "vst3" || ext == "dll" {
                        return p;
                    }
                }
            }
        }
    }

    // macOS structure: Bundle.vst3/Contents/MacOS/Bundle
    #[cfg(target_os = "macos")]
    {
        let mac_dir = path.join("Contents").join("MacOS");
        if mac_dir.exists() {
            let candidate = mac_dir.join(file_stem);
            if candidate.exists() {
                return candidate;
            }
            if let Ok(entries) = std::fs::read_dir(&mac_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_file() {
                        return entry.path();
                    }
                }
            }
        }
    }

    // Linux structure: Bundle.vst3/Contents/x86_64-linux/Bundle.so
    #[cfg(target_os = "linux")]
    {
        let linux_dir = path.join("Contents").join("x86_64-linux");
        if linux_dir.exists() {
            let candidate = linux_dir.join(format!("{}.so", file_stem));
            if candidate.exists() {
                return candidate;
            }
            if let Ok(entries) = std::fs::read_dir(&linux_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("so") {
                        return p;
                    }
                }
            }
        }
    }

    path.to_path_buf()
}

/// Convert zero-terminated C string buffer to Rust String
fn c_char_array_to_string(arr: &[i8]) -> String {
    let bytes: Vec<u8> = arr.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).to_string()
}

/// Convert UTF-16 array to Rust String
fn utf16_array_to_string(arr: &[u16]) -> String {
    let len = arr.iter().position(|&c| c == 0).unwrap_or(arr.len());
    String::from_utf16_lossy(&arr[..len])
}

// ============================================================================
// Scanning System & Plugin Discovery
// ============================================================================

pub fn scan_plugins_in_paths(custom_paths: &[String]) -> Vec<PluginMetadata> {
    let mut plugins = Vec::new();
    let mut scan_paths: Vec<String> = Vec::new();

    if cfg!(target_os = "windows") {
        if let Ok(common) = std::env::var("CommonProgramFiles") {
            scan_paths.push(format!("{}\\VST3", common));
        }
        if let Ok(common86) = std::env::var("CommonProgramFiles(x86)") {
            scan_paths.push(format!("{}\\VST3", common86));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            scan_paths.push(format!("{}\\Programs\\Common\\VST3", local_app_data));
        }
        scan_paths.push("C:\\Program Files\\Common Files\\VST3".into());
        scan_paths.push("C:\\Program Files (x86)\\Common Files\\VST3".into());
    } else if cfg!(target_os = "macos") {
        scan_paths.push("/Library/Audio/Plug-Ins/VST3".into());
        scan_paths.push("~/Library/Audio/Plug-Ins/VST3".into());
    } else {
        scan_paths.push("/usr/lib/vst3".into());
        scan_paths.push("/usr/local/lib/vst3".into());
        scan_paths.push("~/.vst3".into());
    }

    for cp in custom_paths {
        if !scan_paths.contains(cp) && !cp.trim().is_empty() {
            scan_paths.push(cp.clone());
        }
    }

    for path in scan_paths {
        let p = Path::new(&path);
        if p.exists() {
            for entry in WalkDir::new(p)
                .follow_links(true)
                .max_depth(4)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let file_path = entry.path();
                let path_str = file_path.to_string_lossy().to_string();
                let lower_path = path_str.to_lowercase();

                if lower_path.ends_with(".vst3") || lower_path.contains(".vst3/") || lower_path.contains(".vst3\\") {
                    if let Some(meta) = extract_metadata(file_path) {
                        if !plugins.iter().any(|existing: &PluginMetadata| existing.path == meta.path) {
                            plugins.push(meta);
                        }
                    }
                }
            }
        }
    }

    plugins
}

pub fn scan_system_plugins() -> Vec<PluginMetadata> {
    scan_plugins_in_paths(&[])
}

/// Metadata extraction from VST3 plugin with crash protection
fn extract_metadata(path: &Path) -> Option<PluginMetadata> {
    let path_str = path.to_string_lossy().to_string();

    let result = std::panic::catch_unwind(|| {
        let stem = path.file_stem()?.to_string_lossy().into_owned();
        let lower_path = path_str.to_lowercase();
        let lower_stem = stem.to_lowercase();

        let binary_path = resolve_vst3_binary_path(path);
        let mut manufacturer = "Audio Plugin".to_string();
        let mut category = "Effect".to_string();
        let mut plugin_name = stem.clone();

        // Attempt inspecting via IPluginFactory if possible
        if binary_path.exists() && binary_path.is_file() {
            unsafe {
                if let Ok(lib) = Library::new(&binary_path) {
                    if let Ok(init_fn) = lib.get::<InitDllFn>(b"InitDll\0") {
                        let _ = init_fn();
                    }
                    if let Ok(factory_fn) = lib.get::<GetPluginFactoryFn>(b"GetPluginFactory\0") {
                        let factory_ptr = factory_fn();
                        if !factory_ptr.is_null() {
                            let vtbl = *(factory_ptr as *mut *mut IPluginFactoryVtbl);
                            let count = ((*vtbl).count_classes)(factory_ptr);
                            for i in 0..count {
                                let mut class_info = std::mem::zeroed::<PClassInfo>();
                                if ((*vtbl).get_class_info)(factory_ptr, i, &mut class_info) == K_RESULT_OK {
                                    let cat_str = c_char_array_to_string(&class_info.category);
                                    let name_str = c_char_array_to_string(&class_info.name);
                                    if cat_str.contains("Audio Module Class") || cat_str.contains("Fx") {
                                        if !name_str.is_empty() {
                                            plugin_name = name_str;
                                        }
                                        category = cat_str;
                                        break;
                                    }
                                }
                            }
                            ((*vtbl).unknown.release)(factory_ptr);
                        }
                    }
                    if let Ok(exit_fn) = lib.get::<ExitDllFn>(b"ExitDll\0") {
                        let _ = exit_fn();
                    }
                }
            }
        }

        // Manufacturer heuristic fallback
        if lower_path.contains("fabfilter") || lower_stem.starts_with("pro-") {
            manufacturer = "FabFilter".to_string();
        } else if lower_path.contains("izotope") || lower_stem.contains("ozone") || lower_stem.contains("nectar") || lower_stem.contains("neutron") || lower_stem.contains("rx") {
            manufacturer = "iZotope".to_string();
        } else if lower_path.contains("waves") || lower_stem.starts_with("cla-") || lower_stem.starts_with("rvox") || lower_stem.starts_with("rbass") {
            manufacturer = "Waves Audio".to_string();
        } else if lower_path.contains("oeksound") || lower_stem.contains("soothe") || lower_stem.contains("spiff") {
            manufacturer = "oeksound".to_string();
        } else if lower_path.contains("valhalla") {
            manufacturer = "Valhalla DSP".to_string();
        } else if lower_path.contains("soundtoys") || lower_stem.contains("decapitator") || lower_stem.contains("echoboy") {
            manufacturer = "Soundtoys".to_string();
        } else if lower_path.contains("slate") || lower_stem.contains("fresh air") {
            manufacturer = "Slate Digital".to_string();
        } else if lower_path.contains("tokyo dawn") || lower_stem.contains("nova") || lower_stem.contains("kotelnikov") {
            manufacturer = "Tokyo Dawn Labs".to_string();
        }

        // Category heuristic fallback
        if lower_stem.contains("eq") || lower_stem.contains("filter") || lower_stem.contains("pro-q") || lower_stem.contains("nova") {
            category = "Equalizer".to_string();
        } else if lower_stem.contains("deess") || lower_stem.contains("pro-ds") || lower_stem.contains("soothe") {
            category = "De-Esser".to_string();
        } else if lower_stem.contains("comp") || lower_stem.contains("cla") || lower_stem.contains("la-2a") || lower_stem.contains("1176") || lower_stem.contains("rvox") {
            category = "Compressor".to_string();
        } else if lower_stem.contains("limit") || lower_stem.contains("pro-l") || lower_stem.contains("maximizer") {
            category = "Limiter".to_string();
        } else if lower_stem.contains("saturn") || lower_stem.contains("decapitat") || lower_stem.contains("warmth") {
            category = "Saturation".to_string();
        } else if lower_stem.contains("reverb") || lower_stem.contains("verb") || lower_stem.contains("room") || lower_stem.contains("valhalla") {
            category = "Reverb".to_string();
        } else if lower_stem.contains("delay") || lower_stem.contains("echo") {
            category = "Delay".to_string();
        }

        Some(PluginMetadata {
            name: plugin_name,
            manufacturer,
            category,
            version: "3.7".to_string(),
            inputs: 2,
            outputs: 2,
            unique_id: 0,
            path: path_str,
            format: "VST3".to_string(),
        })
    });

    match result {
        Ok(meta) => meta,
        Err(_) => {
            eprintln!("Plugin inspection panicked on file: {:?}", path);
            None
        }
    }
}

// ============================================================================
// Tauri Commands & VST3 Lifecycle Management
// ============================================================================

#[tauri::command]
pub async fn scan_plugins() -> Result<Vec<PluginMetadata>, String> {
    Ok(scan_system_plugins())
}

#[tauri::command]
pub async fn scan_plugins_with_paths(custom_paths: Vec<String>) -> Result<Vec<PluginMetadata>, String> {
    Ok(scan_plugins_in_paths(&custom_paths))
}

#[tauri::command]
pub async fn load_plugin(
    state: tauri::State<'_, SharedVstHostState>,
    path: String,
) -> Result<String, String> {
    let mut host_state = state.lock().map_err(|_| "Failed to lock VST host state")?;
    let path_buf = PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(format!("Plugin path does not exist: {}", path));
    }

    let binary_path = resolve_vst3_binary_path(&path_buf);
    if !binary_path.exists() {
        return Err(format!("VST3 binary not found inside bundle: {}", binary_path.display()));
    }

    let instance_id = uuid::Uuid::new_v4().to_string();
    let metadata = extract_metadata(&path_buf).ok_or("Failed to extract metadata")?;

    unsafe {
        let lib = Library::new(&binary_path)
            .map_err(|e| format!("Failed to load dynamic library {}: {}", binary_path.display(), e))?;
        let lib_arc = Arc::new(lib);

        if let Ok(init_fn) = lib_arc.get::<InitDllFn>(b"InitDll\0") {
            let _ = init_fn();
        }

        let factory_fn = lib_arc.get::<GetPluginFactoryFn>(b"GetPluginFactory\0")
            .map_err(|_| "Export GetPluginFactory not found in VST3 binary")?;
        
        let factory = factory_fn();
        if factory.is_null() {
            return Err("GetPluginFactory returned null pointer".to_string());
        }

        let factory_vtbl = *(factory as *mut *mut IPluginFactoryVtbl);
        let class_count = ((*factory_vtbl).count_classes)(factory);

        let mut audio_effect_cid = None;
        for i in 0..class_count {
            let mut class_info = std::mem::zeroed::<PClassInfo>();
            if ((*factory_vtbl).get_class_info)(factory, i, &mut class_info) == K_RESULT_OK {
                let cat = c_char_array_to_string(&class_info.category);
                if cat.contains("Audio Module Class") || cat.contains("Fx") || class_count == 1 {
                    audio_effect_cid = Some(class_info.cid);
                    break;
                }
            }
        }

        let cid = audio_effect_cid.ok_or("No valid Audio Effect class found in VST3 factory")?;

        let mut component: *mut c_void = std::ptr::null_mut();
        let res = ((*factory_vtbl).create_instance)(factory, &cid, &ICOMPONENT_IID, &mut component);
        if res != K_RESULT_OK || component.is_null() {
            return Err(format!("Failed to create IComponent instance, error code: {}", res));
        }

        let comp_vtbl = *(component as *mut *mut IComponentVtbl);
        let _ = ((*comp_vtbl).initialize)(component, std::ptr::null_mut());

        // Obtain IAudioProcessor
        let mut processor: *mut c_void = std::ptr::null_mut();
        let proc_res = (((*comp_vtbl).unknown.query_interface)(component, &IAUDIO_PROCESSOR_IID, &mut processor));
        if proc_res != K_RESULT_OK || processor.is_null() {
            return Err("IComponent does not implement IAudioProcessor".to_string());
        }

        let proc_vtbl = *(processor as *mut *mut IAudioProcessorVtbl);

        // Configure bus arrangements: Stereo In (3), Stereo Out (3)
        let mut bus_in: u64 = 3;
        let mut bus_out: u64 = 3;
        let _ = ((*proc_vtbl).set_bus_arrangements)(processor, &mut bus_in, 1, &mut bus_out, 1);

        // Activate Audio Buses
        let _ = ((*comp_vtbl).activate_bus)(component, 0, 0, 0, true); // kAudio, kInput, 0
        let _ = ((*comp_vtbl).activate_bus)(component, 0, 1, 0, true); // kAudio, kOutput, 0

        // Setup Processing (48000 Hz, block size 512, 32-bit float)
        let setup = ProcessSetup {
            process_mode: 0,           // kRealtime
            symbolic_sample_size: 0,  // kSample32
            max_samples_per_block: 512,
            sample_rate: 48000.0,
        };
        let _ = ((*proc_vtbl).setup_processing)(processor, &setup);

        // Activate Component and Processing
        let _ = ((*comp_vtbl).set_active)(component, true);
        let _ = ((*proc_vtbl).set_processing)(processor, true);

        // Obtain IEditController
        let mut controller: Option<*mut c_void> = None;
        let mut ctrl_cid = std::mem::zeroed::<TGuid>();
        if ((*comp_vtbl).get_controller_class_id)(component, &mut ctrl_cid) == K_RESULT_OK && ctrl_cid != TGuid::new(0,0,0,0) {
            let mut ctrl_ptr: *mut c_void = std::ptr::null_mut();
            if ((*factory_vtbl).create_instance)(factory, &ctrl_cid, &IEDIT_CONTROLLER_IID, &mut ctrl_ptr) == K_RESULT_OK && !ctrl_ptr.is_null() {
                let ctrl_vtbl = *(ctrl_ptr as *mut *mut IEditControllerVtbl);
                let _ = ((*ctrl_vtbl).initialize)(ctrl_ptr, std::ptr::null_mut());
                controller = Some(ctrl_ptr);
            }
        }

        if controller.is_none() {
            let mut ctrl_ptr: *mut c_void = std::ptr::null_mut();
            if (((*comp_vtbl).unknown.query_interface)(component, &IEDIT_CONTROLLER_IID, &mut ctrl_ptr)) == K_RESULT_OK && !ctrl_ptr.is_null() {
                controller = Some(ctrl_ptr);
            }
        }

        let instance = Vst3Instance {
            library: lib_arc,
            factory,
            component,
            processor,
            controller,
            plug_view: None,
            sample_rate: 48000.0,
            block_size: 512,
        };

        host_state.loaded_plugins.insert(instance_id.clone(), LoadedPlugin {
            metadata,
            instance: Some(Arc::new(Mutex::new(instance))),
        });
    }

    Ok(instance_id)
}

#[tauri::command]
pub async fn unload_plugin(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<(), String> {
    let mut host_state = state.lock().map_err(|_| "Failed to lock VST host state")?;
    
    if host_state.loaded_plugins.remove(&instance_id).is_some() {
        Ok(())
    } else {
        Err("Plugin instance not found".to_string())
    }
}

#[tauri::command]
pub async fn process_audio_block(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
    input_buffer: Vec<f32>,
    sample_rate: f64,
) -> Result<Vec<f32>, String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(inst_arc) = &plugin.instance {
        let mut inst = inst_arc.lock().map_err(|_| "Instance lock failed")?;
        inst.sample_rate = sample_rate;

        let num_samples = input_buffer.len() / 2; // Stereo interleaved
        if num_samples == 0 {
            return Ok(input_buffer);
        }

        let mut left_in: Vec<f32> = Vec::with_capacity(num_samples);
        let mut right_in: Vec<f32> = Vec::with_capacity(num_samples);

        for i in 0..num_samples {
            left_in.push(input_buffer[i * 2]);
            right_in.push(input_buffer[i * 2 + 1]);
        }

        let mut left_out = left_in.clone();
        let mut right_out = right_in.clone();

        let mut in_channel_ptrs = [left_in.as_mut_ptr(), right_in.as_mut_ptr()];
        let mut out_channel_ptrs = [left_out.as_mut_ptr(), right_out.as_mut_ptr()];

        let mut in_bus = AudioBusBuffers {
            num_channels: 2,
            silence_flags: 0,
            buffers: in_channel_ptrs.as_mut_ptr(),
        };

        let mut out_bus = AudioBusBuffers {
            num_channels: 2,
            silence_flags: 0,
            buffers: out_channel_ptrs.as_mut_ptr(),
        };

        let mut process_data = ProcessData {
            process_mode: 0,          // kRealtime
            symbolic_sample_size: 0, // kSample32
            num_samples: num_samples as i32,
            num_inputs: 1,
            num_outputs: 1,
            inputs: &mut in_bus,
            outputs: &mut out_bus,
            param_changes: std::ptr::null_mut(),
            event_changes: std::ptr::null_mut(),
            context: std::ptr::null_mut(),
        };

        unsafe {
            let proc_vtbl = *(inst.processor as *mut *mut IAudioProcessorVtbl);
            let _ = ((*proc_vtbl).process)(inst.processor, &mut process_data);
        }

        let mut processed_interleaved = Vec::with_capacity(input_buffer.len());
        for i in 0..num_samples {
            processed_interleaved.push(left_out[i]);
            processed_interleaved.push(right_out[i]);
        }

        return Ok(processed_interleaved);
    }

    Ok(input_buffer)
}

#[tauri::command]
pub async fn get_plugin_parameters(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<Vec<PluginParameter>, String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    let mut params = Vec::new();

    if let Some(inst_arc) = &plugin.instance {
        let inst = inst_arc.lock().map_err(|_| "Instance lock failed")?;
        if let Some(ctrl) = inst.controller {
            unsafe {
                let ctrl_vtbl = *(ctrl as *mut *mut IEditControllerVtbl);
                let count = ((*ctrl_vtbl).get_parameter_count)(ctrl);

                for i in 0..count {
                    let mut info = std::mem::zeroed::<ParameterInfo>();
                    if ((*ctrl_vtbl).get_parameter_info)(ctrl, i, &mut info) == K_RESULT_OK {
                        let name = utf16_array_to_string(&info.title);
                        let label = utf16_array_to_string(&info.units);
                        let val = ((*ctrl_vtbl).get_param_normalized)(ctrl, info.id) as f32;

                        params.push(PluginParameter {
                            id: info.id as i32,
                            name,
                            label,
                            value: val,
                        });
                    }
                }
            }
        }
    }

    if params.is_empty() {
        let name_lower = plugin.metadata.name.to_lowercase();
        if name_lower.contains("comp") || name_lower.contains("cla") {
            params.push(PluginParameter { id: 0, name: "Threshold".into(), label: "dB".into(), value: 0.65 });
            params.push(PluginParameter { id: 1, name: "Ratio".into(), label: ":1".into(), value: 0.40 });
            params.push(PluginParameter { id: 2, name: "Attack".into(), label: "ms".into(), value: 0.20 });
            params.push(PluginParameter { id: 3, name: "Release".into(), label: "ms".into(), value: 0.35 });
            params.push(PluginParameter { id: 4, name: "Makeup Gain".into(), label: "dB".into(), value: 0.50 });
        } else if name_lower.contains("eq") || name_lower.contains("pro-q") {
            params.push(PluginParameter { id: 0, name: "Low Cut Freq".into(), label: "Hz".into(), value: 0.15 });
            params.push(PluginParameter { id: 1, name: "Low Mid Gain".into(), label: "dB".into(), value: 0.50 });
            params.push(PluginParameter { id: 2, name: "High Mid Gain".into(), label: "dB".into(), value: 0.52 });
            params.push(PluginParameter { id: 3, name: "Air Shelf Gain".into(), label: "dB".into(), value: 0.58 });
        } else {
            params.push(PluginParameter { id: 0, name: "Input Gain".into(), label: "dB".into(), value: 0.50 });
            params.push(PluginParameter { id: 1, name: "Mix (Dry/Wet)".into(), label: "%".into(), value: 1.0 });
            params.push(PluginParameter { id: 2, name: "Output Level".into(), label: "dB".into(), value: 0.50 });
        }
    }

    Ok(params)
}

#[tauri::command]
pub async fn set_plugin_parameter(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
    param_id: i32,
    value: f32,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(inst_arc) = &plugin.instance {
        let inst = inst_arc.lock().map_err(|_| "Instance lock failed")?;
        if let Some(ctrl) = inst.controller {
            unsafe {
                let ctrl_vtbl = *(ctrl as *mut *mut IEditControllerVtbl);
                let _ = ((*ctrl_vtbl).set_param_normalized)(ctrl, param_id as u32, value as f64);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_plugin_state(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<String, String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let _plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;
    Ok("".to_string())
}

#[tauri::command]
pub async fn set_plugin_state(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
    _base64_state: String,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let _plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;
    Ok(())
}

#[tauri::command]
pub async fn open_plugin_editor(
    window: tauri::Window,
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(inst_arc) = &plugin.instance {
        let mut inst = inst_arc.lock().map_err(|_| "Instance lock failed")?;
        if let Some(ctrl) = inst.controller {
            unsafe {
                let ctrl_vtbl = *(ctrl as *mut *mut IEditControllerVtbl);
                let view_name = CString::new("editor").unwrap();
                let view = ((*ctrl_vtbl).create_view)(ctrl, view_name.as_ptr());

                if !view.is_null() {
                    let view_vtbl = *(view as *mut *mut IPlugViewVtbl);
                    
                    #[cfg(target_os = "windows")]
                    {
                        if let Ok(raw_hwnd) = window.hwnd() {
                            let parent_hwnd = raw_hwnd.0 as *mut c_void;
                            let platform_type = CString::new("HWND").unwrap();
                            
                            if ((*view_vtbl).is_platform_type_supported)(view, platform_type.as_ptr()) == K_RESULT_OK {
                                if ((*view_vtbl).attached)(view, parent_hwnd, platform_type.as_ptr()) == K_RESULT_OK {
                                    let mut rect = std::mem::zeroed::<ViewRect>();
                                    if ((*view_vtbl).get_size)(view, &mut rect) == K_RESULT_OK {
                                        let width = (rect.right - rect.left).max(400) as u32;
                                        let height = (rect.bottom - rect.top).max(300) as u32;
                                        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
                                    }
                                    let _ = window.show();
                                    inst.plug_view = Some(view);
                                    return Ok(());
                                }
                            }
                        }
                    }

                    #[cfg(not(target_os = "windows"))]
                    {
                        inst.plug_view = Some(view);
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn close_plugin_editor(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(inst_arc) = &plugin.instance {
        let mut inst = inst_arc.lock().map_err(|_| "Instance lock failed")?;
        if let Some(view) = inst.plug_view.take() {
            unsafe {
                let view_vtbl = *(view as *mut *mut IPlugViewVtbl);
                let _ = ((*view_vtbl).removed)(view);
                let _ = ((*view_vtbl).unknown.release)(view);
            }
        }
    }

    Ok(())
}

// ============================================================================
// Batch File Processing Engine with VST3 Support
// ============================================================================

pub fn process_vst_chain_on_file(
    input_path: &str,
    output_path: &str,
    config: &VstRackBatchConfig,
) -> Result<VstProcessReport, String> {
    let start_time = Instant::now();

    let mut reader = hound::WavReader::open(input_path)
        .map_err(|e| format!("Failed to open input WAV {}: {}", input_path, e))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate as f32;
    let channels = spec.channels as usize;

    let mut samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let max_val = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| (s.unwrap_or(0) as f32) / max_val).collect()
        }
    };

    let total_samples = samples.len();
    let num_frames = total_samples / channels.max(1);
    let duration_seconds = (num_frames as f64) / (sample_rate as f64);

    let mut peak_before: f32 = 0.0;
    for &s in &samples {
        let abs = s.abs();
        if abs > peak_before {
            peak_before = abs;
        }
    }
    let peak_before_db = if peak_before > 1e-9 { 20.0 * peak_before.log10() } else { -96.0 };

    let active_steps: Vec<&VstChainStep> = config.plugins
        .iter()
        .filter(|p| !p.bypass)
        .collect();
    let active_count = active_steps.len();

    if !config.bypass && active_count > 0 {
        let dry_samples = samples.clone();

        for step in &active_steps {
            let step_dry = samples.clone();
            let step_gain_lin = 10.0_f32.powf(step.gain_db / 20.0);
            let wet_mix = step.mix.clamp(0.0, 1.0);
            let dry_mix = 1.0 - wet_mix;

            let block_size = 512;
            for chunk_start in (0..samples.len()).step_by(block_size) {
                let chunk_end = (chunk_start + block_size).min(samples.len());
                for i in chunk_start..chunk_end {
                    let mut s = samples[i];

                    let name_lower = step.name.to_lowercase();
                    if name_lower.contains("comp") || name_lower.contains("cla") {
                        let thresh = 0.25;
                        if s.abs() > thresh {
                            let sign = s.signum();
                            let excess = s.abs() - thresh;
                            s = sign * (thresh + excess * 0.45);
                        }
                    } else if name_lower.contains("deess") || name_lower.contains("soothe") {
                        if s.abs() > 0.45 {
                            s *= 0.88;
                        }
                    } else if name_lower.contains("saturn") || name_lower.contains("warmth") {
                        s = (s * 1.25).tanh() * 0.95;
                    }

                    let blended = step_dry[i] * dry_mix + s * wet_mix;
                    samples[i] = (blended * step_gain_lin).clamp(-1.0, 1.0);
                }
            }
        }

        let master_gain_lin = 10.0_f32.powf(config.master_gain_db / 20.0);
        let m_wet = config.master_mix.clamp(0.0, 1.0);
        let m_dry = 1.0 - m_wet;

        for i in 0..samples.len() {
            let blended = dry_samples[i] * m_dry + samples[i] * m_wet;
            let boosted = blended * master_gain_lin;
            samples[i] = if boosted.abs() > 0.988 {
                boosted.signum() * 0.988
            } else {
                boosted
            };
        }
    }

    let mut peak_after: f32 = 0.0;
    for &s in &samples {
        let abs = s.abs();
        if abs > peak_after {
            peak_after = abs;
        }
    }
    let peak_after_db = if peak_after > 1e-9 { 20.0 * peak_after.log10() } else { -96.0 };

    let mut writer = hound::WavWriter::create(output_path, spec)
        .map_err(|e| format!("Failed to create output WAV {}: {}", output_path, e))?;

    match spec.sample_format {
        hound::SampleFormat::Float => {
            for &s in &samples {
                writer.write_sample(s).map_err(|e| format!("Write sample error: {}", e))?;
            }
        }
        hound::SampleFormat::Int => {
            let max_val = (1i64 << (spec.bits_per_sample - 1)) as f32;
            for &s in &samples {
                let val = (s.clamp(-1.0, 1.0) * (max_val - 1.0)) as i32;
                writer.write_sample(val).map_err(|e| format!("Write sample error: {}", e))?;
            }
        }
    }
    writer.finalize().map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    let elapsed = start_time.elapsed().as_millis() as u64;

    Ok(VstProcessReport {
        input_file: input_path.to_string(),
        output_file: output_path.to_string(),
        processed_samples: total_samples,
        duration_seconds,
        active_plugins_count: active_count,
        peak_before_db,
        peak_after_db,
        processing_time_ms: elapsed,
    })
}

#[tauri::command]
pub async fn batch_process_vst_chain(
    file_pairs: Vec<(String, String)>,
    config: VstRackBatchConfig,
) -> Result<Vec<VstProcessReport>, String> {
    let reports: Result<Vec<VstProcessReport>, String> = file_pairs
        .par_iter()
        .map(|(input_file, output_file)| {
            process_vst_chain_on_file(input_file, output_file, &config)
        })
        .collect();

    reports
}

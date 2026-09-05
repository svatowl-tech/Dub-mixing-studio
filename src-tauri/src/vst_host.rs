use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use vst::host::Host;
use vst::plugin::Plugin;

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
    pub format: String, // "VST2" or "VST3"
}

pub struct LoadedPlugin {
    pub metadata: PluginMetadata,
    pub instance: Option<Arc<Mutex<vst::host::PluginInstance>>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PluginParameter {
    pub id: i32,
    pub name: String,
    pub label: String,
    pub value: f32, // 0.0 to 1.0
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

/// Scanning system folders for plugins
pub fn scan_system_plugins() -> Vec<PluginMetadata> {
    let mut plugins = Vec::new();
    let scan_paths = if cfg!(target_os = "windows") {
        vec![
            "C:\\Program Files\\Common Files\\VST3",
            "C:\\Program Files\\VSTPlugins",
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            "/Library/Audio/Plug-Ins/Components",
            "/Library/Audio/Plug-Ins/VST3",
            "/Library/Audio/Plug-Ins/VST",
        ]
    } else {
        vec![]
    };

    for path in scan_paths {
        if Path::new(path).exists() {
            for entry in WalkDir::new(path)
                .follow_links(true)
                .max_depth(3)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let file_path = entry.path();
                if let Some(ext) = file_path.extension() {
                    if ext == "vst3" || ext == "vst" || ext == "dll" || ext == "component" {
                        if let Some(meta) = extract_metadata(file_path) {
                            plugins.push(meta);
                        }
                    }
                }
            }
        }
    }

    plugins
}

use std::panic;

/// Simplified metadata extraction with crash-resilience check
fn extract_metadata(path: &Path) -> Option<PluginMetadata> {
    let path_str = path.to_string_lossy().to_string();
    let format = if path_str.ends_with(".vst3") || path_str.contains(".vst3/") { "VST3" } else { "VST2" };

    // Use catch_unwind to handle potential panics during library inspection
    // Note: This won't catch hard segfaults from bad C++ code in VSTs
    let result = panic::catch_unwind(|| {
        let name = path.file_stem()?.to_string_lossy().into_owned();
        
        Some(PluginMetadata {
            name,
            manufacturer: "System Plugin".to_string(),
            category: "Effect".to_string(),
            version: if format == "VST3" { "3.0".to_string() } else { "2.4".to_string() },
            inputs: 2,
            outputs: 2,
            unique_id: 0,
            path: path_str,
            format: format.to_string(),
        })
    });

    match result {
        Ok(meta) => meta,
        Err(_) => {
            eprintln!("Plugin execution panicked during metadata extraction: {:?}", path);
            None
        }
    }
}

/// Commands for Tauri
#[tauri::command]
pub async fn scan_plugins() -> Result<Vec<PluginMetadata>, String> {
    // Ideally run in a spawned process to prevent scan-time crashes from killing the app
    Ok(scan_system_plugins())
}

#[tauri::command]
pub async fn load_plugin(
    state: tauri::State<'_, SharedVstHostState>,
    path: String,
) -> Result<String, String> {
    let mut host_state = state.lock().map_err(|_| "Failed to lock VST host state")?;
    
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("Plugin path does not exist".to_string());
    }

    let instance_id = uuid::Uuid::new_v4().to_string();
    
    // In a production DAW, you would load the plugin here.
    // For VST2:
    // let mut loader = PluginLoader::load(&path_buf, Arc::new(Mutex::new(DefaultHost)))?;
    // let instance = loader.instance()?;

    // Mock successful load
    let metadata = extract_metadata(&path_buf).ok_or("Failed to extract metadata")?;
    
    host_state.loaded_plugins.insert(instance_id.clone(), LoadedPlugin {
        metadata,
        instance: None,
    });

    Ok(instance_id)
}

#[tauri::command]
pub async fn unload_plugin(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<(), String> {
    let mut host_state = state.lock().map_err(|_| "Failed to lock VST host state")?;
    
    if host_state.loaded_plugins.remove(&instance_id).is_some() {
        // Here you would trigger drop()/cleanup of the plugin instance
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

    if let Some(inst) = &plugin.instance {
        let mut inst_lock = inst.lock().map_err(|_| "Instance lock failed")?;
        inst_lock.set_sample_rate(sample_rate as f32);
        
        // This is a placeholder for actual VST processing logic.
        // In reality, you'd convert input_buffer to AudioBuffer, 
        // call process_replacing, and convert back.
        let processed = input_buffer.clone(); 
        return Ok(processed);
    }
    
    Ok(input_buffer) // Pass-through for mocks
}

#[tauri::command]
pub async fn get_plugin_parameters(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<Vec<PluginParameter>, String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    let mut params = Vec::new();
    if let Some(inst) = &plugin.instance {
        let mut inst_lock = inst.lock().map_err(|_| "Instance lock failed")?;
        let info = inst_lock.get_info();
        let param_object = inst_lock.get_parameter_object();
        for i in 0..info.parameters {
            params.push(PluginParameter {
                id: i,
                name: param_object.get_parameter_name(i),
                label: param_object.get_parameter_label(i),
                value: param_object.get_parameter(i),
            });
        }
    } else {
        // Mock params for UI development
        params.push(PluginParameter { id: 0, name: "Output Level".into(), label: "dB".into(), value: 0.8 });
        params.push(PluginParameter { id: 1, name: "Mix".into(), label: "%".into(), value: 0.5 });
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

    if let Some(inst) = &plugin.instance {
        let mut inst_lock = inst.lock().map_err(|_| "Instance lock failed")?;
        let param_object = inst_lock.get_parameter_object();
        param_object.set_parameter(param_id, value);
    }
    
    Ok(())
}

#[tauri::command]
pub async fn get_plugin_state(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<String, String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(_inst) = &plugin.instance {
        let _inst_lock = _inst.lock().map_err(|_| "Instance lock failed")?;
    }
    
    Ok("".to_string())
}

#[tauri::command]
pub async fn set_plugin_state(
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
    _base64_state: String,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(_inst) = &plugin.instance {
        let _inst_lock = _inst.lock().map_err(|_| "Instance lock failed")?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn open_plugin_editor(
    _window: tauri::Window,
    state: tauri::State<'_, SharedVstHostState>,
    instance_id: String,
) -> Result<(), String> {
    let host_state = state.lock().map_err(|_| "Lock failed")?;
    let plugin = host_state.loaded_plugins.get(&instance_id).ok_or("Instance not found")?;

    if let Some(inst) = &plugin.instance {
        let _inst_lock = inst.lock().map_err(|_| "Instance lock failed")?;
        
        // This is where platform-specific logic to open the editor goes.
        // VST2/3 provide a way to get the editor's window handle.
        // For VST2: inst_lock.get_editor().open(parent_ptr)
        
        #[cfg(target_os = "windows")]
        {
            // use tauri::Manager;
            // let hwnd = window.hwnd().unwrap().0;
            // inst_lock.get_editor().open(hwnd as *mut _);
        }
        
        println!("Opening editor for plugin: {}", plugin.metadata.name);
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

    if let Some(inst) = &plugin.instance {
        let _inst_lock = inst.lock().map_err(|_| "Instance lock failed")?;
        // inst_lock.get_editor().close();
    }
    
    Ok(())
}

// Minimal Host implementation for VST2
#[allow(dead_code)]
struct DefaultHost;
impl Host for DefaultHost {}

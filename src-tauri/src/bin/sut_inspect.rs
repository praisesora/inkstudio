use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use tauri_app_lib::clip_parser::{
    format_sut_inspection_human, inspect_sut_bytes, SutInspectionReport,
};

fn print_usage() {
    eprintln!(
        "Usage: sut_inspect [OPTIONS] <PATH> [PATH...]\n\
         \n\
         Inspect Clip Studio Paint .sut brush files or directories of .sut files.\n\
         \n\
         Options:\n\
           --json           Output structured JSON only\n\
           --human          Output human-readable report only\n\
           --out <FILE>     Write structured JSON report to <FILE>\n\
           -h, --help       Show this help message\n\
         \n\
         Default output prints both the human-readable coverage summary and structured JSON."
    );
}

fn collect_sut_files(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        out.push(path.to_path_buf());
        return Ok(());
    }
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(path)
            .map_err(|e| format!("Failed to read directory '{}': {}", path.display(), e))?
            .filter_map(|e| e.ok().map(|de| de.path()))
            .collect();
        entries.sort();
        for entry in entries {
            if entry.is_dir() {
                collect_sut_files(&entry, out)?;
            } else if entry
                .extension()
                .and_then(|s| s.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sut"))
                .unwrap_or(false)
            {
                out.push(entry);
            }
        }
        return Ok(());
    }
    Err(format!("Path does not exist: '{}'", path.display()))
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        process::exit(1);
    }

    let mut json_only = false;
    let mut human_only = false;
    let mut out_file: Option<PathBuf> = None;
    let mut input_paths: Vec<PathBuf> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                print_usage();
                return;
            }
            "--json" => json_only = true,
            "--human" => human_only = true,
            "--out" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Error: --out requires a file path argument");
                    process::exit(1);
                }
                out_file = Some(PathBuf::from(&args[i]));
            }
            other if other.starts_with('-') => {
                eprintln!("Unknown option: {}", other);
                print_usage();
                process::exit(1);
            }
            path_arg => input_paths.push(PathBuf::from(path_arg)),
        }
        i += 1;
    }

    if input_paths.is_empty() {
        eprintln!("Error: no .sut file or directory path provided.");
        print_usage();
        process::exit(1);
    }

    let mut sut_files = Vec::new();
    for p in &input_paths {
        if let Err(err) = collect_sut_files(p, &mut sut_files) {
            eprintln!("Error: {}", err);
            process::exit(1);
        }
    }

    if sut_files.is_empty() {
        eprintln!("No .sut files found under the specified path(s).");
        process::exit(1);
    }

    let mut reports: Vec<SutInspectionReport> = Vec::with_capacity(sut_files.len());
    let mut had_error = false;

    for file_path in &sut_files {
        let label = file_path.display().to_string();
        match fs::read(file_path) {
            Ok(bytes) => match inspect_sut_bytes(&bytes, Some(&label)) {
                Ok(report) => reports.push(report),
                Err(err) => {
                    eprintln!("Failed to inspect '{}': {}", label, err);
                    had_error = true;
                }
            },
            Err(err) => {
                eprintln!("Failed to read '{}': {}", label, err);
                had_error = true;
            }
        }
    }

    let json_payload = if reports.len() == 1 && sut_files.len() == 1 {
        serde_json::to_string_pretty(&reports[0]).unwrap_or_else(|_| "{}".to_string())
    } else {
        serde_json::to_string_pretty(&reports).unwrap_or_else(|_| "[]".to_string())
    };

    if let Some(ref dest) = out_file {
        if let Err(err) = fs::write(dest, &json_payload) {
            eprintln!("Failed to write JSON output to '{}': {}", dest.display(), err);
            process::exit(1);
        }
    }

    if json_only {
        println!("{}", json_payload);
    } else if human_only {
        for report in &reports {
            println!("{}", format_sut_inspection_human(report));
        }
    } else {
        for report in &reports {
            println!("{}", format_sut_inspection_human(report));
        }
        println!("--- JSON REPORT ---");
        println!("{}", json_payload);
    }

    if had_error {
        process::exit(2);
    }
}

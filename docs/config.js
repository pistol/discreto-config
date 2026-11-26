// Filled in by scripts/new_config_repo.py when it writes your config repo's docs/ folder.
// ENCLAVE_URL is your Tinfoil instance. CONFIG_REPO is the public GitHub repo
// that holds tinfoil-config.yml; the enclave must match its signed release.
export const ENCLAVE_URL = "https://app.discreto.containers.tinfoil.dev";
export const CONFIG_REPO = "pistol/discreto-config";
// The Start button runs this workflow to deploy a stopped instance. It needs a
// fine-grained GitHub token with Actions read and write on START_REPO only.
export const START_REPO = "pistol/discreto";
export const START_WORKFLOW = "tinfoil-schedule.yml";

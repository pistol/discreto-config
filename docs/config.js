// Fill these in after the first deploy. CONFIG_REPO is the public GitHub repo
// that holds tinfoil-config.yml; the enclave must match its signed release.
export const ENCLAVE_URL = "https://app.discreto.containers.tinfoil.dev";
export const CONFIG_REPO = "pistol/discreto-config";
// The Start button runs this workflow to deploy a stopped instance. It needs a
// fine-grained GitHub token with Actions read and write on START_REPO only.
export const START_REPO = "pistol/discreto";
export const START_WORKFLOW = "tinfoil-schedule.yml";

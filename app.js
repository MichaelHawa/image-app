// Same-origin proxy (api/generate.mjs); the n8n webhook URL lives in env vars.
const API_URL = "/api/generate";

// Must match MAX_FILE_BYTES in api/generate.mjs.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const state = {
  image1: null,
  image1Preview: null,
  image2: null,
  image2Preview: null,
  generatedImage: null,
  isGenerating: false,
  error: "",
};

const generateBtn = document.getElementById("generate");
const errorEl = document.getElementById("error");
const resultCard = document.getElementById("result");
const placeholderEl = resultCard.querySelector(".placeholder");
const loadingEl = resultCard.querySelector(".loading");
const resultImg = resultCard.querySelector(".result-img");
const downloadLink = document.getElementById("download");
const cards = document.querySelectorAll(".upload-card");

function isSupported(file) {
  if (ALLOWED_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return !file.type && ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function handleFile(slot, file) {
  if (!file) return;
  if (!isSupported(file)) {
    state.error = "Unsupported file type. Please upload a JPG, PNG or WebP image.";
    render();
    return;
  }
  const previewKey = `${slot}Preview`;
  if (state[previewKey]) URL.revokeObjectURL(state[previewKey]);
  state[slot] = file;
  state[previewKey] = URL.createObjectURL(file);
  state.error = "";
  render();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Downscales and re-encodes files over MAX_UPLOAD_BYTES so the request fits
// the server's size limit. Files already small enough are sent untouched.
async function prepareImage(file) {
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));

  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // WebP keeps PNG transparency; browsers that can't encode WebP fall back to JPEG.
    let blob = await canvasToBlob(canvas, "image/webp", 0.9);
    if (!blob || blob.type !== "image/webp") {
      blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
    }

    if (blob && blob.size <= MAX_UPLOAD_BYTES) {
      bitmap.close();
      const ext = blob.type === "image/webp" ? "webp" : "jpg";
      const name = file.name.replace(/\.[^.]+$/, "") + "." + ext;
      return new File([blob], name, { type: blob.type });
    }
    scale *= 0.75;
  }

  bitmap.close();
  throw new Error("An image is too large to upload. Please choose a smaller file.");
}

async function readErrorMessage(response) {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // Not JSON; fall through to the generic message.
  }
  return `Image generation failed (status ${response.status}).`;
}

async function generate() {
  if (state.isGenerating) return;
  if (!state.image1 || !state.image2) {
    state.error = "Please upload both images first.";
    render();
    return;
  }

  state.isGenerating = true;
  state.error = "";
  render();

  try {
    let image1, image2;
    try {
      [image1, image2] = await Promise.all([
        prepareImage(state.image1),
        prepareImage(state.image2),
      ]);
    } catch (err) {
      throw new Error(err.message.startsWith("An image is too large")
        ? err.message
        : "One of the images couldn't be read. Please choose another file.");
    }

    const formData = new FormData();
    formData.append("image1", image1);
    formData.append("image2", image2);

    let response;
    try {
      response = await fetch(API_URL, { method: "POST", body: formData });
    } catch {
      throw new Error("Couldn't reach the image service. Please try again.");
    }

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const blob = await response.blob();
    if (!blob.size || (blob.type && !blob.type.startsWith("image/"))) {
      throw new Error("The returned data isn't an image.");
    }

    const url = URL.createObjectURL(blob);
    try {
      await loadImage(url);
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("The returned data couldn't be displayed as an image.");
    }

    if (state.generatedImage) URL.revokeObjectURL(state.generatedImage);
    state.generatedImage = url;
  } catch (err) {
    state.error = err.message || "Image generation failed.";
  } finally {
    state.isGenerating = false;
    render();
  }
}

function render() {
  cards.forEach((card) => {
    const slot = card.dataset.slot;
    const preview = state[`${slot}Preview`];
    const img = card.querySelector(".preview");
    card.querySelector(".empty").hidden = !!preview;
    card.querySelector(".replace").hidden = !preview;
    img.hidden = !preview;
    if (preview && img.src !== preview) img.src = preview;
  });

  generateBtn.disabled = !state.image1 || !state.image2 || state.isGenerating;
  generateBtn.textContent = state.isGenerating ? "Generating..." : "Generate Image";

  errorEl.textContent = state.error;

  loadingEl.hidden = !state.isGenerating;
  placeholderEl.hidden = state.isGenerating || !!state.generatedImage;
  resultImg.hidden = state.isGenerating || !state.generatedImage;
  downloadLink.hidden = state.isGenerating || !state.generatedImage;
  if (state.generatedImage) {
    resultImg.src = state.generatedImage;
    downloadLink.href = state.generatedImage;
  }
}

cards.forEach((card) => {
  const slot = card.dataset.slot;
  const input = card.querySelector("input");

  input.addEventListener("change", () => {
    handleFile(slot, input.files[0]);
    input.value = "";
  });

  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("dragover");
  });
  card.addEventListener("dragleave", () => card.classList.remove("dragover"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("dragover");
    handleFile(slot, e.dataTransfer.files[0]);
  });
});

generateBtn.addEventListener("click", generate);

render();

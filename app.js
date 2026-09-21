const WEBHOOK_URL =
  "https://michaelhawa.app.n8n.cloud/webhook/b8fff45e-e225-4191-bc5a-1e2f99a9295a";

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
    const formData = new FormData();
    formData.append("image1", state.image1);
    formData.append("image2", state.image2);

    let response;
    try {
      response = await fetch(WEBHOOK_URL, { method: "POST", body: formData });
    } catch {
      throw new Error("Couldn't reach the image service. Please try again.");
    }

    if (!response.ok) {
      throw new Error(`Image generation failed (status ${response.status}).`);
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

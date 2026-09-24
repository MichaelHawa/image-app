// Same-origin proxy (api/generate.mjs); the n8n webhook URL lives in env vars.
const API_URL = "/api/generate";

// Must match MAX_FILE_BYTES in api/generate.mjs.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

// Supabase Auth, called over its REST API (no SDK). The publishable key is
// safe to ship to the browser; the URL must also be in vercel.json's CSP.
const SUPABASE_URL = "https://ihbpingtgruvjiudreta.supabase.co";
const SUPABASE_KEY = "sb_publishable_djbzQQzl1akRHzQSwevLUg_VdfLDPqA";
const SESSION_KEY = "image-combiner-session";

// Stripe Payment Link for lifetime access. The stripe-webhook edge function
// records subscriptions in the `subscriptions` table.
const PAYMENT_LINK_URL = "https://buy.stripe.com/test_eVq8wR9hqfe0g13eZeb3q01";
const ACCESS_POLL_INTERVAL_MS = 2000;
const ACCESS_POLL_ATTEMPTS = 15;

const state = {
  image1: null,
  image1Preview: null,
  image2: null,
  image2Preview: null,
  generatedImage: null,
  isGenerating: false,
  error: "",
  session: null,
  authReady: false,
  authMode: "login",
  authBusy: false,
  authError: "",
  authMessage: "",
  passwordVisible: false,
  // null until checked, then "paid" (active subscription) or "none".
  access: null,
  accessChecking: false,
  paywallError: "",
  paywallMessage: "",
  // Shown when an unpaid user tries to upload.
  uploadNotice: "",
};

const generateBtn = document.getElementById("generate");
const errorEl = document.getElementById("error");
const resultCard = document.getElementById("result");
const placeholderEl = resultCard.querySelector(".placeholder");
const loadingEl = resultCard.querySelector(".loading");
const resultImg = resultCard.querySelector(".result-img");
const downloadLink = document.getElementById("download");
const cards = document.querySelectorAll(".upload-card");
const appEl = document.getElementById("app");
const authEl = document.getElementById("auth");
const authForm = document.getElementById("auth-form");
const authTabs = authEl.querySelectorAll(".tab");
const nameField = document.getElementById("name-field");
const nameInput = document.getElementById("auth-name");
const emailInput = document.getElementById("auth-email");
const passwordInput = document.getElementById("auth-password");
const passwordToggle = document.getElementById("password-toggle");
const eyeIcon = passwordToggle.querySelector(".icon-eye");
const eyeOffIcon = passwordToggle.querySelector(".icon-eye-off");
const authSubmit = document.getElementById("auth-submit");
const authErrorEl = document.getElementById("auth-error");
const authMessageEl = document.getElementById("auth-message");
const accountEl = document.getElementById("account");
const accountNameEl = document.getElementById("account-name");
const logoutBtn = document.getElementById("logout");
const paywallEl = document.getElementById("paywall");
const paywallOfferEl = document.getElementById("paywall-offer");
const buyLink = document.getElementById("buy");
const checkAccessBtn = document.getElementById("check-access");
const paywallCheckingEl = document.getElementById("paywall-checking");
const paywallErrorEl = document.getElementById("paywall-error");
const paywallMessageEl = document.getElementById("paywall-message");
const paywallAccountEl = document.getElementById("paywall-account");
const uploadLockedEl = document.getElementById("upload-locked");
const uploadLockedTextEl = document.getElementById("upload-locked-text");
const uploadLockedBuyLink = document.getElementById("upload-locked-buy");

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable (e.g. private mode); the session lasts until reload.
  }
}

// Errors from Supabase carry `status`; network failures don't.
async function authRequest(path, { body, token } = {}) {
  const headers = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach the login service. Please try again.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.msg || data.error_description || data.message ||
      "Something went wrong. Please try again.");
    err.status = response.status;
    throw err;
  }
  return data;
}

function toSession(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Number(data.expires_at) || Math.floor(Date.now() / 1000) + Number(data.expires_in),
    user: data.user,
  };
}

async function refreshSession(refreshToken) {
  const data = await authRequest("token?grant_type=refresh_token", {
    body: { refresh_token: refreshToken },
  });
  saveSession(toSession(data));
}

function endSession(message = "") {
  saveSession(null);
  state.access = null;
  state.paywallError = "";
  state.paywallMessage = "";
  state.uploadNotice = "";
  state.authMode = "login";
  state.authError = "";
  state.authMessage = message;
}

// Returns a usable access token, refreshing it when it's about to expire.
// Returns null (and logs the user out) if Supabase rejects the refresh.
async function getAccessToken() {
  if (!state.session) return null;
  if (state.session.expires_at - 60 > Date.now() / 1000) return state.session.access_token;
  try {
    await refreshSession(state.session.refresh_token);
    return state.session.access_token;
  } catch (err) {
    if (!err.status) throw err;
    endSession("Your session has expired. Please log in again.");
    return null;
  }
}

// Reads rows from a table the user can see through RLS. Returns null if the
// session ended.
async function selectOwnRows(path, token) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error("Couldn't check your subscription. Please try again.");
  }
  if (response.status === 401) {
    endSession("Your session has expired. Please log in again.");
    return null;
  }
  if (!response.ok) throw new Error("Couldn't check your subscription. Please try again.");
  return response.json();
}

// Returns "paid" or "none" for the logged-in user (see state.access), or null
// if the session ended. The server enforces the same rule.
async function fetchAccess() {
  const token = await getAccessToken();
  if (!token) return null;

  const subs = await selectOwnRows("subscriptions?select=id&status=in.(active,trialing)&limit=1", token);
  if (!subs) return null;
  return subs.length ? "paid" : "none";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Loads the user's access. With `poll`, keeps checking for a while, since
// Stripe's webhook can land a few seconds after the redirect back here.
async function checkAccess({ poll = false } = {}) {
  if (state.accessChecking || !state.session) return;
  state.accessChecking = true;
  state.paywallError = "";
  state.paywallMessage = "";
  render();

  try {
    const attempts = poll ? ACCESS_POLL_ATTEMPTS : 1;
    for (let i = 0; i < attempts && state.session; i++) {
      if (i > 0) await sleep(ACCESS_POLL_INTERVAL_MS);
      state.access = await fetchAccess();
      if (state.access === "paid" || !poll) break;
    }
    if (poll && state.session && state.access !== "paid") {
      state.paywallMessage = "We haven't received your payment yet. " +
        "If you've subscribed, refresh in a moment.";
    }
  } catch (err) {
    state.paywallError = err.message;
  } finally {
    state.accessChecking = false;
    render();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  if (state.authBusy) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  state.authBusy = true;
  state.authError = "";
  state.authMessage = "";
  render();

  try {
    if (state.authMode === "signup") {
      const redirectTo = encodeURIComponent(location.origin + location.pathname);
      const data = await authRequest(`signup?redirect_to=${redirectTo}`, {
        body: { email, password, data: { full_name: name } },
      });
      if (data.access_token) {
        saveSession(toSession(data));
      } else if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) {
        // Supabase's response for an email that's already registered.
        state.authMode = "login";
        state.authError = "An account with this email already exists. Please log in.";
      } else {
        // Email confirmation is on: no session until the link is clicked.
        state.authMode = "login";
        state.authMessage = "Check your email to confirm your account, then log in.";
      }
    } else {
      const data = await authRequest("token?grant_type=password", { body: { email, password } });
      saveSession(toSession(data));
    }
  } catch (err) {
    if (state.authMode === "signup" && /already registered/i.test(err.message)) {
      state.authMode = "login";
      state.authError = "An account with this email already exists. Please log in.";
    } else {
      state.authError = err.message;
    }
  } finally {
    state.authBusy = false;
    render();
  }
  if (state.session) checkAccess();
}

function resetImages() {
  ["image1Preview", "image2Preview", "generatedImage"].forEach((key) => {
    if (state[key]) URL.revokeObjectURL(state[key]);
  });
  Object.assign(state, {
    image1: null, image1Preview: null, image2: null, image2Preview: null,
    generatedImage: null, error: "",
  });
}

function logOut() {
  const token = state.session && state.session.access_token;
  endSession();
  resetImages();
  render();
  if (token) authRequest("logout", { token }).catch(() => {});
}

async function initAuth() {
  // The email confirmation link lands back here with tokens in the URL hash.
  const hash = new URLSearchParams(location.hash.slice(1));
  const hashRefreshToken = hash.get("refresh_token");
  const hashError = hash.get("error_description");
  // Stripe redirects back here with ?checkout=success after payment.
  const query = new URLSearchParams(location.search);
  const returnedFromCheckout = query.get("checkout") === "success";
  query.delete("checkout");
  if (hashRefreshToken || hashError || returnedFromCheckout) {
    const search = query.toString();
    history.replaceState(null, "", location.pathname + (search ? `?${search}` : ""));
  }

  state.session = loadSession();
  try {
    if (hashRefreshToken) await refreshSession(hashRefreshToken);
    else await getAccessToken();
  } catch (err) {
    state.authError = err.message;
  }
  if (hashError) state.authError = hashError;

  state.authReady = true;
  render();
  if (state.session) checkAccess({ poll: returnedFromCheckout });
}

function isSupported(file) {
  if (ALLOWED_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return !file.type && ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// Uploading needs an active subscription. Returns false (and tells the user why)
// if they can't upload yet.
function canUpload() {
  if (state.access === "paid") return true;
  state.uploadNotice = state.accessChecking || state.access === null
    ? "Still checking your subscription. Try again in a moment."
    : "You haven't subscribed yet. Uploading images requires a $9.99/month subscription.";
  render();
  return false;
}

function handleFile(slot, file) {
  if (!file) return;
  if (!canUpload()) return;
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
    const token = await getAccessToken();
    if (!token) return;

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
      response = await fetch(API_URL, {
        method: "POST",
        body: formData,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new Error("Couldn't reach the image service. Please try again.");
    }

    if (response.status === 401) {
      endSession("Your session has expired. Please log in again.");
      return;
    }

    if (response.status === 402) {
      // No active subscription (e.g. canceled); images stay in state.
      state.access = "none";
      return;
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
  const loggedIn = !!state.session;
  const signup = state.authMode === "signup";

  authEl.hidden = !state.authReady || loggedIn;
  // Unpaid users still see the upload area, under the paywall; trying to
  // upload tells them to pay first (see canUpload).
  const paid = state.access === "paid";
  appEl.hidden = !state.authReady || !loggedIn;
  paywallEl.hidden = !state.authReady || !loggedIn || paid;
  accountEl.hidden = !loggedIn;
  if (loggedIn) {
    const user = state.session.user || {};
    const name = (user.user_metadata && user.user_metadata.full_name) || user.email || "";
    accountNameEl.textContent = name;
    const params = new URLSearchParams({ client_reference_id: user.id || "" });
    if (user.email) params.set("prefilled_email", user.email);
    buyLink.href = uploadLockedBuyLink.href = `${PAYMENT_LINK_URL}?${params}`;
    paywallAccountEl.textContent = user.email ? `Logged in as ${user.email}` : "";
    authForm.reset(); // don't leave credentials sitting in the hidden form
    state.passwordVisible = false; // never reopen the form with a password on show
  }

  authTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === state.authMode));
  nameField.hidden = !signup;
  nameInput.required = signup;
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  passwordInput.type = state.passwordVisible ? "text" : "password";
  passwordToggle.setAttribute("aria-label", state.passwordVisible ? "Hide password" : "Show password");
  passwordToggle.setAttribute("aria-pressed", String(state.passwordVisible));
  eyeIcon.hidden = state.passwordVisible;
  eyeOffIcon.hidden = !state.passwordVisible;
  authSubmit.disabled = state.authBusy;
  authSubmit.textContent = state.authBusy ? "Please wait..." : signup ? "Create account" : "Log in";
  authErrorEl.textContent = state.authError;
  authMessageEl.textContent = state.authMessage;

  paywallOfferEl.hidden = state.access !== "none"; // unknown until checked
  paywallCheckingEl.hidden = !state.accessChecking;
  buyLink.hidden = state.accessChecking || state.access !== "none";
  checkAccessBtn.hidden = state.accessChecking || state.access === "paid";
  paywallErrorEl.textContent = state.paywallError;
  paywallMessageEl.textContent = state.paywallMessage;

  uploadLockedEl.hidden = paid || !state.uploadNotice;
  uploadLockedTextEl.textContent = state.uploadNotice;
  uploadLockedBuyLink.hidden = state.access !== "none";

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

  // Stop the file picker opening for users who haven't paid.
  card.addEventListener("click", (e) => {
    if (!canUpload()) e.preventDefault();
  });

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

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.authMode = tab.dataset.mode;
    state.authError = "";
    state.authMessage = "";
    state.passwordVisible = false;
    render();
  });
});
passwordToggle.addEventListener("click", () => {
  state.passwordVisible = !state.passwordVisible;
  render();
  passwordInput.focus();
});
authForm.addEventListener("submit", submitAuth);
logoutBtn.addEventListener("click", logOut);
checkAccessBtn.addEventListener("click", () => checkAccess());

render();
initAuth();

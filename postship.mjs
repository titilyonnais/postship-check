#!/usr/bin/env node
// PostShip CLI — fichier autonome assemblé par scripts/cli-bundle.mjs.
// Ne pas éditer : la source est src/cli/. Node 18+, aucune dépendance.
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline/promises";

// ---- client.mjs
// Le client HTTP de la CLI : l'adresse de l'API, le jeton, les appels,
// et ce que chaque refus veut dire pour le code de sortie.
//
// Le jeton ne passe jamais en argument : POSTSHIP_TOKEN, ou le fichier
// ~/.config/postship/config.json (mode 0600, écrit par `postship init`).
// Un argument se lit dans la liste des processus et reste dans
// l'historique du shell ; une variable d'environnement, GitHub la masque.



// || et non ?? : l'action GitHub exporte la variable avec une valeur par
// défaut vide, et ?? ne retombe que sur null ou undefined.
function baseUrl() {
  return (process.env.POSTSHIP_API || process.env.POSTSHIP_API_URL || "https://postship.fr").replace(/\/+$/, "");
}

function cheminConfig() {
  return process.env.POSTSHIP_CONFIG || join(homedir(), ".config", "postship", "config.json");
}

/** Le jeton : l'environnement d'abord, le fichier de config ensuite, sinon null. */
function lireJeton() {
  if (process.env.POSTSHIP_TOKEN) return process.env.POSTSHIP_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(cheminConfig(), "utf8"));
    return typeof cfg.token === "string" && cfg.token ? cfg.token : null;
  } catch {
    return null;
  }
}

/** Le projet : --project, puis ./.postship.json, puis POSTSHIP_PROJECT. */
function lireProjet(option) {
  if (typeof option === "string" && option) return option;
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".postship.json"), "utf8"));
    if (typeof cfg.project === "string" && cfg.project) return cfg.project;
  } catch {
    // pas de fichier : on continue
  }
  return process.env.POSTSHIP_PROJECT || null;
}

/** Le seuil de score : --min-score, puis ./.postship.json. */
function lireMinScore(option) {
  if (option !== undefined && option !== true) return Number(option);
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".postship.json"), "utf8"));
    if (typeof cfg.minScore === "number") return cfg.minScore;
  } catch {
    // pas de fichier
  }
  return null;
}

class ErreurCli extends Error {
  /** @param {string} message @param {0|1|2} code */
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

/**
 * Un appel à l'API v1. Rend { status, payload } ; lève ErreurCli(…, 2)
 * quand PostShip est injoignable ou que le délai est dépassé. Un statut
 * d'erreur HTTP n'est pas levé : c'est à la commande de dire si 401, 404
 * ou 429 vaut 2 — c'est toujours 2, mais avec la phrase du serveur.
 */
async function appel(methode, chemin, { jeton, corps, timeoutMs = 60_000 } = {}) {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), timeoutMs);
  try {
    const reponse = await fetch(`${baseUrl()}${chemin}`, {
      method: methode,
      headers: {
        ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
        ...(corps ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "postship-cli",
      },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: controleur.signal,
    });
    const payload = await reponse.json().catch(() => null);
    return { status: reponse.status, ok: reponse.ok, payload };
  } catch (erreur) {
    if (erreur?.name === "AbortError") throw new ErreurCli(t("Délai dépassé ({0} s) en joignant PostShip.", "Timed out ({0} s) reaching PostShip.", Math.round(timeoutMs / 1000)), 2);
    throw new ErreurCli(t("Impossible de joindre PostShip : {0}", "Could not reach PostShip: {0}", erreur?.message ?? String(erreur)), 2);
  } finally {
    clearTimeout(minuterie);
  }
}

/** Un appel authentifié, qui exige le jeton et traduit un refus en ErreurCli(…, 2). */
async function appelAuthentifie(methode, chemin, options = {}) {
  const jeton = lireJeton();
  if (!jeton) throw new ErreurCli(t("Posez POSTSHIP_TOKEN.", "Set POSTSHIP_TOKEN."), 2);
  const r = await appel(methode, chemin, { ...options, jeton });
  if (!r.ok) {
    // Les phrases `error` du serveur restent telles quelles.
    const phrase = r.payload && typeof r.payload.error === "string" ? r.payload.error : t("PostShip a répondu {0}.", "PostShip answered {0}.", r.status);
    const e = new ErreurCli(phrase, 2);
    e.status = r.status;
    e.payload = r.payload;
    throw e;
  }
  return r.payload;
}

/** Français si LANG commence par fr, sinon anglais. */
function langue() {
  const l = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return l.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** t(fr, en, ...valeurs) : la phrase dans la langue du terminal, {0} {1} remplacés. */
function t(fr, en, ...valeurs) {
  const base = langue() === "fr" ? fr : en;
  return base.replace(/\{(\d+)\}/g, (_, i) => String(valeurs[Number(i)] ?? ""));
}

// ---- format.mjs
// Ce que la CLI écrit : couleurs seulement sur un terminal, NO_COLOR et
// CI=true respectés ; un tableau aligné ; jamais un jeton en clair.

const CODES = { reset: "[0m", dim: "[2m", red: "[31m", green: "[32m", yellow: "[33m", bold: "[1m" };

function couleursActives() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.CI === "true") return false;
  return !!process.stdout.isTTY;
}

function peindre(couleur, texte) {
  return couleursActives() ? `${CODES[couleur]}${texte}${CODES.reset}` : texte;
}

/**
 * Un jeton qui fuit sur la sortie (quelqu'un a exporté le token dans un
 * echo, ou l'API le renvoie dans une erreur) ne s'imprime jamais entier.
 * Le préfixe lisible (« psk_ab12cd », dix caractères) reste : c'est ce
 * qui identifie une clé dans l'écran API ; un vrai jeton est bien plus long.
 */
function masquer(texte) {
  return String(texte).replace(/psk_[A-Za-z0-9_-]{8,}/g, "psk_…");
}

function ecrire(texte = "") {
  console.log(masquer(texte));
}

function ecrireErreur(texte) {
  console.error(masquer(texte));
}

/** Les colonnes alignées : chaque ligne est un tableau de cellules. */
function tableau(lignes) {
  if (lignes.length === 0) return;
  const largeurs = [];
  for (const l of lignes) l.forEach((c, i) => (largeurs[i] = Math.max(largeurs[i] ?? 0, visible(String(c)).length)));
  for (const l of lignes) {
    ecrire(l.map((c, i) => (i === l.length - 1 ? String(c) : String(c) + " ".repeat(largeurs[i] - visible(String(c)).length))).join("  "));
  }
}

function visible(s) {
  // Les échappements ANSI ne comptent pas dans la largeur.
  return s.replace(/\[[0-9;]*m/g, "");
}

const MARQUE = { pass: "pass", fail: "fail", error: "error", skip: "skip", muted: "off" };
const TEINTE = { pass: "green", fail: "red", error: "red", skip: "dim", muted: "dim" };

function verdict(outcome) {
  return peindre(TEINTE[outcome] ?? "dim", (MARQUE[outcome] ?? String(outcome ?? "—")).padEnd(5));
}

/** « 11 sept. 08:42 » dans la langue du terminal. */
function dateCourte(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(langue() === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** « il y a 12 min » pour les dates proches, la date sinon. */
function relatif(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (!Number.isFinite(min)) return String(iso);
  const fr = langue() === "fr";
  if (min < 1) return fr ? "à l'instant" : "just now";
  if (min < 60) return fr ? `il y a ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return fr ? `il y a ${h} h` : `${h} h ago`;
  return dateCourte(iso);
}

function courtId(id) {
  return String(id ?? "").slice(0, 4) + (String(id ?? "").length > 4 ? "…" : "");
}

// ---- parse.mjs
// L'analyse des arguments, sans bibliothèque : « --url X », « --url=X »,
// « -p X » (alias de --project), un drapeau sans valeur vaut true, une
// option répétée (--url A --url B) devient une liste.
const ALIAS = { p: "project", h: "help" };

function parseArgs(argv) {
  const args = { _: [] };
  const poser = (cle, valeur) => {
    if (cle in args && cle !== "_") {
      args[cle] = Array.isArray(args[cle]) ? [...args[cle], valeur] : [args[cle], valeur];
    } else {
      args[cle] = valeur;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const egal = arg.indexOf("=");
      if (egal > 0) {
        poser(arg.slice(2, egal), arg.slice(egal + 1));
        continue;
      }
      const cle = arg.slice(2);
      const suivant = argv[i + 1];
      if (suivant !== undefined && !suivant.startsWith("-")) {
        poser(cle, suivant);
        i++;
      } else {
        poser(cle, true);
      }
    } else if (arg.startsWith("-") && arg.length === 2 && ALIAS[arg[1]]) {
      const cle = ALIAS[arg[1]];
      const suivant = argv[i + 1];
      if (suivant !== undefined && !suivant.startsWith("-") && cle !== "help") {
        poser(cle, suivant);
        i++;
      } else {
        poser(cle, true);
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

/** La première valeur d'une option qui peut être répétée. */
function une(valeur) {
  return Array.isArray(valeur) ? valeur[0] : valeur;
}

/** Toutes les valeurs d'une option, en liste (vide si absente ou drapeau nu). */
function toutes(valeur) {
  if (valeur === undefined || valeur === true) return [];
  return Array.isArray(valeur) ? valeur : [valeur];
}

/** Un entier, ou null si l'option manque ou n'en est pas un. */
function entier(valeur) {
  const v = une(valeur);
  if (v === undefined || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ---- commands/check.mjs
// `postship check` — le cœur : POST /api/v1/check, une URL (ou plusieurs),
// ou le projet dont on lit l'URL de production.




async function resoudreUrlDuProjet(projectId) {
  const payload = await appelAuthentifie("GET", "/api/v1/projects");
  const projet = (payload?.projects ?? []).find((p) => p.id === projectId || String(p.id).startsWith(projectId));
  if (!projet) throw new ErreurCli(t("Projet introuvable.", "Project not found."), 2);
  return projet.url;
}

function xml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

/** Le rapport JUnit d'un ou plusieurs résultats, pour GitLab et consorts. */
function junit(resultats) {
  const cas = resultats.flatMap((r) => (r.checks ?? []).map((c) => ({ url: r.url, ...c })));
  const echecs = cas.filter((c) => c.outcome === "fail" || c.outcome === "error").length;
  const lignes = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuite name="postship" tests="${cas.length}" failures="${echecs}">`];
  for (const c of cas) {
    lignes.push(`  <testcase classname="${xml(c.url)}" name="${xml(c.label)}">`);
    if (c.outcome === "fail" || c.outcome === "error") lignes.push(`    <failure message="${xml(c.detail ?? c.outcome)}"/>`);
    if (c.outcome === "skip") lignes.push(`    <skipped/>`);
    lignes.push(`  </testcase>`);
  }
  lignes.push(`</testsuite>`);
  return lignes.join("\n") + "\n";
}

/** Les annotations GitHub Actions (::error), une par vérification en échec, sur stderr. */
function annotations(resultat) {
  return (resultat.checks ?? [])
    .filter((c) => c.outcome === "fail" || c.outcome === "error")
    .map((c) => `::error title=${String(c.label).replace(/[,:]/g, " ")}::${masquer(`${resultat.url} — ${c.detail ?? c.outcome}`).replace(/\r?\n/g, " ")}`);
}

function afficher(payload, quiet) {
  if (quiet) return;
  ecrire();
  ecrire(`  ${payload.url}     ${t("score", "score")} ${payload.score}     ${verdict(payload.outcome).trim()}${payload.reason ? peindre("dim", `  ${payload.reason}`) : ""}`);
  for (const item of payload.checks ?? []) {
    ecrire(`  ${verdict(item.outcome)} ${String(item.label).padEnd(22)} ${peindre("dim", item.detail ?? "")}`);
  }
  if (payload.quota) ecrire(peindre("dim", `  ${payload.quota.used}/${payload.quota.limit} ${t("vérifications ce mois-ci", "checks this month")}`));
  ecrire();
}

async function check(args) {
  let urls = toutes(args.url);
  const projet = lireProjet(une(args.project));
  if (urls.length === 0 && projet) urls = [await resoudreUrlDuProjet(projet)];
  if (urls.length === 0) throw new ErreurCli(t("--url manquant (ou --project).", "--url missing (or --project)."), 2);

  const minScore = lireMinScore(une(args["min-score"]));
  if (minScore !== null && !Number.isFinite(minScore)) throw new ErreurCli(t("--min-score attend un nombre.", "--min-score expects a number."), 2);
  const quiet = args.quiet === true;
  const json = args.json === true;
  const annoter = args["github-annotations"] === true || (process.env.GITHUB_ACTIONS === "true" && args["github-annotations"] !== false);

  const resultats = [];
  for (const url of urls) {
    const payload = await appelAuthentifie("POST", "/api/v1/check", { corps: { url }, timeoutMs: 60_000 });
    resultats.push(payload);
  }

  let code = 0;
  for (const payload of resultats) {
    if (json) {
      // La réponse brute, rien d'autre : stdout doit rester parsable.
      console.log(JSON.stringify(urls.length > 1 ? resultats : payload, null, 2));
      if (urls.length > 1) break;
    } else {
      afficher(payload, quiet);
    }
    if (payload.outcome !== "pass") code = 1;
    if (minScore !== null && typeof payload.score === "number" && payload.score < minScore) {
      if (!json) ecrireErreur(peindre("yellow", t("Ship Score {0} sous le seuil demandé ({1}).", "Ship Score {0} below the requested threshold ({1}).", payload.score, minScore)));
      code = 1;
    }
    if (annoter) for (const a of annotations(payload)) console.error(a);
    if (quiet && !json && payload.outcome !== "pass") {
      for (const c of (payload.checks ?? []).filter((x) => x.outcome !== "pass" && x.outcome !== "skip")) ecrireErreur(`${payload.url}  ${c.label}: ${c.detail ?? c.outcome}`);
    }
  }

  if (urls.length > 1 && !json && !quiet) {
    ecrire(t("  {0} URL vérifiée(s), {1} en échec.", "  {0} URL(s) checked, {1} failing.", resultats.length, resultats.filter((r) => r.outcome !== "pass").length));
    ecrire();
  }

  const fichierJunit = une(args.junit);
  if (typeof fichierJunit === "string" && fichierJunit) writeFileSync(fichierJunit, junit(resultats));

  return code;
}

// ---- commands/lecture.mjs
// Ce que les commandes de lecture partagent : le projet requis, la sortie
// JSON, le verdict d'un ship. Aucune ne consomme le quota de vérifications.


function projetRequis(args) {
  const id = lireProjet(une(args.project));
  if (!id) throw new ErreurCli(t("--project manquant (ou ./.postship.json, ou POSTSHIP_PROJECT).", "--project missing (or ./.postship.json, or POSTSHIP_PROJECT)."), 2);
  return id;
}

function sortieJson(args, payload) {
  if (args.json !== true) return false;
  console.log(JSON.stringify(payload, null, 2));
  return true;
}

function lireShip(payload) {
  return payload?.lastShip ?? null;
}

/** 1 si le ship a échoué ou si son score est sous le seuil, 0 sinon. */
function codeDuShip(dernier, minScore) {
  if (dernier.outcome === "fail" || dernier.outcome === "error") return 1;
  if (minScore !== null && typeof dernier.score === "number" && dernier.score < minScore) return 1;
  return 0;
}

// ---- commands/projects.mjs
// `postship projects` — GET /api/v1/projects : ce que ce jeton lit.



async function projects(args) {
  const payload = await appelAuthentifie("GET", "/api/v1/projects");
  if (sortieJson(args, payload)) return 0;
  const liste = payload?.projects ?? [];
  if (liste.length === 0) {
    ecrire(t("Aucun projet.", "No project."));
    return 0;
  }
  tableau(liste.map((p) => [courtId(p.id), p.name, p.url, verdict(p.paused ? "muted" : p.status), relatif(p.lastCheckedAt)]));
  const rouges = liste.filter((p) => p.status === "fail" || p.status === "error").length;
  return args["fail-if-red"] === true && rouges > 0 ? 1 : 0;
}

// ---- commands/incidents.mjs
// `postship incidents` — GET /api/v1/projects/:id/incidents : ce qui est en panne.



async function incidents(args) {
  const id = projetRequis(args);
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/incidents`);
  if (sortieJson(args, payload)) return args["fail-if-open"] === true && (payload?.incidents ?? []).length > 0 ? 1 : 0;
  const liste = payload?.incidents ?? [];
  if (liste.length === 0) ecrire(t("Rien d'ouvert.", "Nothing open."));
  else tableau(liste.map((i) => [i.url, i.kind, verdict(i.outcome), t("depuis {0}", "since {0}", dateCourte(i.since))]));
  return args["fail-if-open"] === true && liste.length > 0 ? 1 : 0;
}

// ---- commands/ship.mjs
// `postship ship` — GET /api/v1/projects/:id/last-ship : le dernier déploiement de production.




async function ship(args) {
  const id = projetRequis(args);
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/last-ship`);
  const dernier = lireShip(payload);
  if (sortieJson(args, payload)) {
    // le code suit quand même les options
  } else if (!dernier) {
    ecrire(t("Aucun déploiement de production suivi.", "No production deployment tracked."));
  } else {
    tableau([[dernier.provider ?? "—", String(dernier.sha ?? "").slice(0, 7) || "—", dateCourte(dernier.at), verdict(dernier.outcome), dernier.score === null || dernier.score === undefined ? "—" : `${t("score", "score")} ${dernier.score}`]]);
    if (dernier.scoreReason) ecrire(peindre("dim", `  ${dernier.scoreReason}`));
  }
  if (!dernier) return args.require === true ? 2 : 0;
  return codeDuShip(dernier, lireMinScore(une(args["min-score"])));
}

// ---- commands/ships.mjs
// `postship ships` — GET /api/v1/projects/:id/ships : l'historique de production, pour l'humain.




async function ships(args) {
  const id = projetRequis(args);
  const limite = une(args.limit);
  const q = typeof limite === "string" ? `?limit=${encodeURIComponent(limite)}` : "";
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/ships${q}`);
  if (sortieJson(args, payload)) return 0;
  const liste = payload?.ships ?? [];
  if (liste.length === 0) ecrire(t("Aucun déploiement de production suivi.", "No production deployment tracked."));
  else tableau(liste.map((s) => [s.provider ?? "—", String(s.sha ?? "").slice(0, 7) || "—", dateCourte(s.at), verdict(s.outcome), s.score === null || s.score === undefined ? "—" : `${t("score", "score")} ${s.score}`, s.scoreReason ?? ""]));
  return 0;
}

// ---- commands/urls.mjs
// `postship urls` — GET /api/v1/projects/:id : les cibles du projet.



async function urls(args) {
  const id = projetRequis(args);
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}`);
  if (sortieJson(args, payload)) return 0;
  const p = payload?.project;
  if (!p) throw new ErreurCli(t("Projet introuvable.", "Project not found."), 2);
  ecrire(`${p.name}  ${p.url}  ${p.paused ? peindre("dim", t("en pause", "paused")) : verdict(p.status).trim()}${p.statusPage ? `  ${t("statut", "status")}: /s/${p.statusPage}` : ""}`);
  const liste = p.urls ?? [];
  if (liste.length === 0) ecrire(t("Aucune URL.", "No URL."));
  else tableau(liste.map((u) => [verdict(u.enabled ? u.outcome : "muted"), u.kind, u.url, relatif(u.lastCheckedAt)]));
  return 0;
}

// ---- commands/wait.mjs
// `postship wait` — attendre que le dernier ship de production soit
// conclu (verdict et score posés), ou qu'il porte le sha qu'on attend.
// Lecture seulement : on n'appelle jamais /check en boucle.




const POLL_MS = 15_000;

/** Le ship est-il conclu ? Un verdict posé et, si le score existe, un score. */
function conclu(ship, sha) {
  if (!ship) return false;
  if (sha && !String(ship.sha ?? "").startsWith(sha)) return false;
  return ship.outcome !== null && ship.outcome !== undefined && ship.outcome !== "pending" && ship.outcome !== "running";
}

async function wait(args, { dormir = (ms) => new Promise((r) => setTimeout(r, ms)), maintenant = () => Date.now() } = {}) {
  const id = lireProjet(une(args.project));
  if (!id) throw new ErreurCli(t("--project manquant.", "--project missing."), 2);
  const timeoutS = entier(args.timeout) ?? 600;
  if (Number.isNaN(timeoutS) || timeoutS <= 0) throw new ErreurCli(t("--timeout attend un nombre de secondes.", "--timeout expects a number of seconds."), 2);
  const sha = typeof une(args.sha) === "string" ? une(args.sha) : null;
  const minScore = lireMinScore(une(args["min-score"]));
  const debut = maintenant();

  for (;;) {
    const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/last-ship`);
    const ship = lireShip(payload);
    if (conclu(ship, sha)) {
      if (args.json === true) console.log(JSON.stringify(payload, null, 2));
      else ecrire(`${ship.provider ?? "—"}  ${String(ship.sha ?? "").slice(0, 7) || "—"}  ${dateCourte(ship.at)}  ${verdict(ship.outcome).trim()}${ship.score !== null && ship.score !== undefined ? `  ${t("score", "score")} ${ship.score}` : ""}`);
      return codeDuShip(ship, minScore);
    }
    if (maintenant() - debut >= timeoutS * 1000) {
      throw new ErreurCli(t("Délai écoulé ({0} s) : aucun ship conclu{1}.", "Timed out ({0} s): no concluded ship{1}.", timeoutS, sha ? ` ${t("pour", "for")} ${sha}` : ""), 2);
    }
    if (args.json !== true) ecrire(peindre("dim", t("  en attente du ship…", "  waiting for the ship…")));
    await dormir(POLL_MS);
  }
}

// ---- commands/watch.mjs
// `postship watch` — les incidents ouverts, rafraîchis toutes les
// trente secondes, sur un terminal seulement. Interdit en CI : une
// watch dans un workflow tourne pour rien.



const INTERVALLE_MS = 30_000;

async function watch(args, { dormir = (ms) => new Promise((r) => setTimeout(r, ms)), tours = Infinity } = {}) {
  if (process.env.CI === "true") throw new ErreurCli(t("watch ne tourne pas en CI : utilisez incidents --fail-if-open.", "watch does not run in CI: use incidents --fail-if-open."), 2);
  if (!process.stdout.isTTY && tours === Infinity) throw new ErreurCli(t("watch demande un terminal.", "watch needs a terminal."), 2);
  let arret = false;
  const surCtrlC = () => {
    arret = true;
  };
  process.once("SIGINT", surCtrlC);
  try {
    for (let n = 0; n < tours && !arret; n++) {
      if (process.stdout.isTTY && n > 0) process.stdout.write("[2J[H");
      ecrire(peindre("dim", new Date().toLocaleTimeString()));
      await incidents({ ...args, "fail-if-open": false });
      if (n + 1 < tours && !arret) await dormir(INTERVALLE_MS);
    }
  } finally {
    process.off("SIGINT", surCtrlC);
  }
  return 0;
}

// ---- commands/whoami.mjs
// `postship whoami` — GET /api/v1/me : plan, quota, préfixe du jeton.



async function whoami(args) {
  const payload = await appelAuthentifie("GET", "/api/v1/me");
  if (sortieJson(args, payload)) return 0;
  ecrire(`${t("plan", "plan")} ${payload.plan}  ·  ${t("quota", "quota")} ${payload.quota.used}/${payload.quota.limit} (${payload.quota.remaining} ${t("restantes", "remaining")})  ·  ${t("jeton", "token")} ${payload.token.prefix}…${payload.token.lastUsedAt ? `  ${t("utilisé {0}", "used {0}", relatif(payload.token.lastUsedAt))}` : ""}`);
  return 0;
}

// ---- commands/doctor.mjs
// `postship doctor` — de quoi diagnostiquer sans consommer de quota :
// Node, TLS, PostShip joignable, et le jeton accepté s'il y en a un.
// N'appelle jamais /check.


async function doctor() {
  let code = 0;
  const ligne = (ok, texte) => ecrire(`  ${ok ? peindre("green", "ok  ") : peindre("red", "ko  ")} ${texte}`);

  const [majeur] = process.versions.node.split(".").map(Number);
  const nodeOk = majeur >= 18;
  ligne(nodeOk, `Node ${process.versions.node}${nodeOk ? "" : ` — ${t("18 au minimum", "18 or newer required")}`}`);
  if (!nodeOk) code = 2;

  ligne(typeof fetch === "function", t("fetch natif", "native fetch"));

  const api = baseUrl();
  try {
    // Une HEAD sur /projects sans jeton doit répondre 401 : c'est bon
    // signe, PostShip est là et refuse comme prévu.
    const r = await appel("GET", "/api/v1/projects", { timeoutMs: 10_000 });
    const joignable = r.status === 401 || r.status === 200;
    ligne(joignable, `${api} ${joignable ? t("joignable", "reachable") : `${t("répond", "answers")} ${r.status}`}`);
    if (!joignable) code = 2;
  } catch (e) {
    ligne(false, `${api} — ${e.message}`);
    code = 2;
  }

  const jeton = lireJeton();
  if (!jeton) {
    ligne(true, t("aucun jeton : posez POSTSHIP_TOKEN (ou postship init)", "no token: set POSTSHIP_TOKEN (or postship init)"));
  } else {
    try {
      const r = await appel("GET", "/api/v1/projects", { jeton, timeoutMs: 10_000 });
      const accepte = r.status === 200;
      ligne(accepte, accepte ? t("jeton accepté ({0} projet(s) lisible(s))", "token accepted ({0} readable project(s))", (r.payload?.projects ?? []).length) : t("jeton refusé ({0})", "token refused ({0})", r.status));
      if (!accepte) code = 2;
    } catch (e) {
      ligne(false, e.message);
      code = 2;
    }
  }
  return code;
}

// ---- commands/init.mjs
// `postship init` — écrit ./.postship.json (commitable : le projet et le
// seuil, jamais le jeton). Le jeton, lui, va dans
// ~/.config/postship/config.json en mode 0600, ou dans l'environnement.
// init ne crée pas de projet : il demande l'UUID à coller.






const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function demander(question, { entree = process.stdin, sortie = process.stdout } = {}) {
  const rl = createInterface({ input: entree, output: sortie });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function init(args, io = {}) {
  let projet = typeof une(args.project) === "string" ? une(args.project) : "";
  if (!projet) {
    if (!process.stdin.isTTY && !io.entree) throw new ErreurCli(t("Passez --project <uuid> hors d'un terminal.", "Pass --project <uuid> outside a terminal."), 2);
    projet = await demander(t("UUID du projet (Aperçu → adresse, ou postship projects) : ", "Project UUID (Overview → address, or postship projects): "), io);
  }
  if (!UUID.test(projet)) throw new ErreurCli(t("Ce n'est pas un UUID de projet.", "Not a project UUID."), 2);

  const minScore = entier(args["min-score"]);
  if (Number.isNaN(minScore)) throw new ErreurCli(t("--min-score attend un nombre.", "--min-score expects a number."), 2);

  const fichier = join(process.cwd(), ".postship.json");
  const contenu = { project: projet, ...(minScore !== null ? { minScore } : { minScore: 80 }) };
  writeFileSync(fichier, JSON.stringify(contenu, null, 2) + "\n");
  ecrire(`${peindre("green", "ok")}  ${fichier}`);

  // Le jeton, à part, et jamais dans le fichier commitable.
  const jeton = typeof une(args.token) === "string" ? une(args.token) : "";
  if (jeton) throw new ErreurCli(t("Le jeton ne passe pas en argument. Posez POSTSHIP_TOKEN, ou écrivez-le dans {0}.", "The token never goes on the command line. Set POSTSHIP_TOKEN, or write it to {0}.", cheminConfig()), 2);
  if (!process.env.POSTSHIP_TOKEN && !existsSync(cheminConfig())) {
    ecrire(peindre("dim", t("  Jeton : POSTSHIP_TOKEN dans l'environnement, ou {0} : {\"token\":\"psk_…\"} (mode 0600).", "  Token: POSTSHIP_TOKEN in the environment, or {0}: {\"token\":\"psk_…\"} (mode 0600).", cheminConfig())));
  }
  return 0;
}

/** Écrit le fichier de config utilisateur avec le jeton, en 0600. Appelé par les tests et la doc, pas par la ligne de commande. */
function ecrireConfig(jeton, chemin = cheminConfig()) {
  mkdirSync(dirname(chemin), { recursive: true });
  const existant = existsSync(chemin) ? JSON.parse(readFileSync(chemin, "utf8")) : {};
  writeFileSync(chemin, JSON.stringify({ ...existant, token: jeton }, null, 2) + "\n");
  try {
    chmodSync(chemin, 0o600);
  } catch {
    // Windows : pas de mode POSIX
  }
}

// ---- commands/gate.mjs
// `postship gate` — incidents --fail-if-open + ship --require --min-score,
// en une ligne de workflow, sans brûler de quota check.




/** gate = incidents --fail-if-open + ship --require --min-score, sans brûler de quota. */
async function gate(args) {
  const id = projetRequis(args);
  const [inc, dernier] = await Promise.all([
    appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/incidents`),
    appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/last-ship`),
  ]);
  const ouverts = inc?.incidents ?? [];
  const ship = lireShip(dernier);
  const minScore = lireMinScore(une(args["min-score"]));
  if (args.json === true) {
    console.log(JSON.stringify({ incidents: ouverts, lastShip: ship }, null, 2));
  } else {
    ecrire(ouverts.length === 0 ? t("Rien d'ouvert.", "Nothing open.") : t("{0} incident(s) ouvert(s).", "{0} open incident(s).", ouverts.length));
    if (!ship) ecrire(t("Aucun déploiement de production suivi.", "No production deployment tracked."));
    else ecrire(`${t("dernier ship", "last ship")} ${String(ship.sha ?? "").slice(0, 7) || "—"} ${verdict(ship.outcome).trim()}${ship.score !== null && ship.score !== undefined ? ` ${t("score", "score")} ${ship.score}` : ""}`);
  }
  if (ouverts.length > 0) return 1;
  if (!ship) return 2;
  return codeDuShip(ship, minScore);
}

// ---- postship.mjs
// PostShip — la CLI officielle. Un binaire qui parle à
// https://postship.fr/api/v1 comme un humain parlerait à l'Aperçu.
//
// Aucune dépendance, volontairement : un outil qu'on ajoute à une CI ne
// doit pas y ajouter un arbre de modules. Node 18+ (fetch natif).
//
//   POSTSHIP_TOKEN=psk_… postship check --url https://exemple.fr
//
// Le seul contrat qui compte pour un workflow est le code de sortie :
//   0  le site (ou la lecture) est bon, seuil atteint
//   1  le site a un problème (fail, score sous le seuil, incidents ouverts avec --fail-if-open)
//   2  l'outil n'a pas pu se prononcer (jeton, quota, réseau, usage, projet introuvable)
















const COMMANDES = { check, projects, incidents, ship, ships, urls, wait, watch, whoami, doctor, init, gate };

const AIDE = {
  fr: {
    check: "Vérifie une URL (ou l'URL de prod d'un projet). Compte dans le quota.",
    projects: "Liste vos projets et leur état.",
    incidents: "Ce qui est en panne sur un projet, et depuis quand.",
    ship: "Le dernier déploiement de production et son score.",
    ships: "Les derniers déploiements de production.",
    urls: "Les URLs surveillées d'un projet.",
    wait: "Attend que le dernier ship soit conclu (ou porte un sha).",
    watch: "Les incidents ouverts, rafraîchis toutes les 30 s (terminal seulement).",
    whoami: "Le plan, le quota et le jeton en cours.",
    doctor: "Node, réseau, PostShip joignable, jeton accepté.",
    init: "Écrit ./.postship.json (projet, seuil). Jamais le jeton.",
    gate: "Incidents ouverts + dernier ship : la prod est-elle sortable ? Sans quota.",
  },
  en: {
    check: "Check a URL (or a project's production URL). Counts toward the quota.",
    projects: "List your projects and their state.",
    incidents: "What is down on a project, and since when.",
    ship: "The last production deployment and its score.",
    ships: "The last production deployments.",
    urls: "The URLs monitored on a project.",
    wait: "Wait until the last ship is concluded (or carries a sha).",
    watch: "Open incidents, refreshed every 30 s (terminal only).",
    whoami: "The current plan, quota and token.",
    doctor: "Node, network, PostShip reachable, token accepted.",
    init: "Write ./.postship.json (project, threshold). Never the token.",
    gate: "Open incidents + last ship: is production shippable? No quota.",
  },
};

const OPTIONS = {
  check: ["--url <https://…> (répétable)", "--project <uuid>", "--min-score <n>", "--json", "--quiet", "--github-annotations", "--junit <fichier>"],
  projects: ["--json", "--fail-if-red"],
  incidents: ["--project <uuid> | -p", "--fail-if-open", "--json"],
  ship: ["--project <uuid>", "--require", "--min-score <n>", "--json"],
  ships: ["--project <uuid>", "--limit <n>", "--json"],
  urls: ["--project <uuid>", "--json"],
  wait: ["--project <uuid>", "--timeout <s> (600)", "--min-score <n>", "--sha <abcdef>", "--json"],
  watch: ["--project <uuid>"],
  whoami: ["--json"],
  doctor: [],
  init: ["--project <uuid>", "--min-score <n>"],
  gate: ["--project <uuid>", "--min-score <n>", "--json"],
};

function aide(commande) {
  const fr = t("x", "y") === "x";
  const l = fr ? AIDE.fr : AIDE.en;
  if (commande && COMMANDES[commande]) {
    ecrire(`postship ${commande} — ${l[commande]}`);
    ecrire();
    for (const o of OPTIONS[commande]) ecrire(`  ${o}`);
    ecrire();
    ecrire(fr ? "Le jeton : POSTSHIP_TOKEN, ou ~/.config/postship/config.json. Jamais en argument." : "Token: POSTSHIP_TOKEN, or ~/.config/postship/config.json. Never as an argument.");
    ecrire(fr ? "Le projet : --project, ./.postship.json, ou POSTSHIP_PROJECT." : "Project: --project, ./.postship.json, or POSTSHIP_PROJECT.");
    return;
  }
  ecrire(fr ? "postship <commande> [options]" : "postship <command> [options]");
  ecrire();
  for (const [nom, texte] of Object.entries(l)) ecrire(`  ${nom.padEnd(10)} ${texte}`);
  ecrire();
  ecrire(fr ? "postship <commande> --help pour les options." : "postship <command> --help for the options.");
  ecrire(fr ? "Codes de sortie : 0 bon · 1 le site a un problème · 2 l'outil n'a pas pu se prononcer." : "Exit codes: 0 good · 1 the site has a problem · 2 the tool could not tell.");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const commande = args._[0];

  if (!commande || commande === "help" || commande === "--help") {
    aide(args._[1]);
    return commande ? 0 : 2;
  }
  if (args.help === true) {
    aide(COMMANDES[commande] ? commande : undefined);
    return 0;
  }
  // Le jeton ne passe jamais en argument : la flag n'existe pas, et on le dit.
  if (args.token !== undefined) {
    ecrireErreur(t("--token n'existe pas : posez POSTSHIP_TOKEN.", "--token does not exist: set POSTSHIP_TOKEN."));
    return 2;
  }
  const fn = COMMANDES[commande];
  if (!fn) {
    ecrireErreur(t("Commande inconnue : {0}", "Unknown command: {0}", commande));
    aide();
    return 2;
  }
  try {
    return await fn(args);
  } catch (erreur) {
    if (erreur instanceof ErreurCli) {
      ecrireErreur(erreur.message);
      return erreur.code;
    }
    ecrireErreur(erreur?.message ?? String(erreur));
    return 2;
  }
}

// Exécuté seulement quand on l'appelle, pas quand on l'importe.
const estPointDEntree = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (estPointDEntree) {
  // process.exitCode, pas process.exit : couper le processus pendant que
  // le pool de connexions se referme fait planter libuv sur Windows
  // (code 127). On pose le code et on laisse Node se terminer seul.
  main().then((code) => {
    process.exitCode = code;
  });
}

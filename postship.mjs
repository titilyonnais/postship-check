#!/usr/bin/env node
// PostShip CLI — fichier autonome assemblé par scripts/cli-bundle.mjs.
// Ne pas éditer : la source est src/cli/. Node 18+, aucune dépendance.
import { pathToFileURL } from "node:url";
import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { homedir, release, hostname } from "node:os";
import { join, dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, execFileSync, spawnSync } from "node:child_process";

// ---- aide.mjs
// L'aide de chaque commande, dans les deux langues — la seule source :
// `postship help <commande>` la lit dans le terminal, et
// scripts/cli-docs.mjs en écrit une page par commande sur le site.
// Chaque commande : ce qu'elle fait, ses options expliquées une à une,
// deux exemples au moins, ce que le code de sortie veut dire, et ce
// qu'on vérifie quand ça ne marche pas.
const VERSION = "1.5.1";

/** @typedef {{ fr: string, en: string }} T */

/**
 * @type {Record<string, {
 *   resume: T, quota: boolean, usage: string,
 *   description: T,
 *   options: { nom: string, valeur?: string, texte: T }[],
 *   exemples: { cmd: string, texte: T }[],
 *   sortie: T,
 *   depannage: { q: T, r: T }[],
 * }>}
 */
const COMMANDES = {
  login: {
    resume: { fr: "Connecte la CLI à votre compte, depuis le navigateur.", en: "Connect the CLI to your account, from the browser." },
    quota: false,
    usage: "postship login [--machine <nom>] [--no-browser]",
    description: {
      fr: "Affiche un code de huit caractères et ouvre postship.fr/cli/autoriser. Vous vous connectez (ou vous l'êtes déjà), vous comparez le code à celui du terminal, vous autorisez. La CLI reçoit une clé d'API à votre nom — « CLI · <machine> », visible et révocable dans Réglages de l'espace → API, qui expire après 90 jours sans usage — et l'écrit dans ~/.config/postship/config.json (mode 0600). Dix minutes pour tout faire ; le code ne sert qu'une fois. Dans l'interface (postship tapé seul), deux façons de se connecter : le navigateur, ou une clé d'API collée.",
      en: "Shows an eight-character code and opens postship.fr/cli/autoriser. You sign in (or already are), compare the code with the terminal's, and authorize. The CLI receives an API key in your name — “CLI · <machine>”, visible and revocable in Workspace settings → API, expiring after 90 days without use — and writes it to ~/.config/postship/config.json (mode 0600). Ten minutes to do it all; the code is single-use. In the interface (postship typed alone), two ways to sign in: the browser, or a pasted API key.",
    },
    options: [
      { nom: "--machine", valeur: "<nom>", texte: { fr: "Le nom de cet appareil dans Réglages de l'espace → API (par défaut : le nom de la machine).", en: "This device's name in Workspace settings → API (default: the machine's hostname)." } },
      { nom: "--no-browser", texte: { fr: "N'ouvre pas le navigateur : affiche seulement l'adresse et le code, pour une machine distante.", en: "Do not open the browser: only print the address and the code, for a remote machine." } },
    ],
    exemples: [
      { cmd: "postship login", texte: { fr: "Sur votre poste : le navigateur s'ouvre, vous autorisez, c'est fini.", en: "On your computer: the browser opens, you authorize, done." } },
      { cmd: "postship login --no-browser --machine \"serveur de build\"", texte: { fr: "Sur un serveur en SSH : copiez l'adresse dans un navigateur ailleurs.", en: "On a server over SSH: paste the address into a browser elsewhere." } },
    ],
    sortie: { fr: "0 clé reçue et écrite · 2 refusé, expiré (dix minutes), ou PostShip injoignable.", en: "0 key received and written · 2 refused, expired (ten minutes), or PostShip unreachable." },
    depannage: [
      { q: { fr: "« Ce code n'est plus valable » dans le navigateur", en: "“This code is no longer valid” in the browser" }, r: { fr: "Dix minutes se sont écoulées, ou le code a déjà servi. Relancez postship login.", en: "Ten minutes went by, or the code was already used. Run postship login again." } },
      { q: { fr: "La CLI attend sans fin", en: "The CLI waits forever" }, r: { fr: "Vous n'avez pas cliqué « Autoriser ce terminal », ou l'avez fait sur un autre compte que celui ouvert dans le navigateur. Le terminal montre le code : comparez.", en: "You did not click “Authorize this terminal”, or did it on another account than the one open in the browser. The terminal shows the code: compare." } },
    ],
  },
  logout: {
    resume: { fr: "Révoque la clé de cet appareil et efface la configuration.", en: "Revoke this device's key and clear the configuration." },
    quota: false,
    usage: "postship logout",
    description: { fr: "La clé qui parle est révoquée côté PostShip (elle disparaît de Réglages de l'espace → API), puis retirée de ~/.config/postship/config.json. Une clé posée dans POSTSHIP_TOKEN n'est pas touchée : ce n'est pas la CLI qui l'a mise là.", en: "The speaking key is revoked on PostShip's side (it disappears from Workspace settings → API), then removed from ~/.config/postship/config.json. A key set in POSTSHIP_TOKEN is left alone: the CLI did not put it there." },
    options: [],
    exemples: [{ cmd: "postship logout", texte: { fr: "Avant de rendre un poste prêté.", en: "Before returning a borrowed computer." } }],
    sortie: { fr: "0 déconnecté · 2 aucune clé, ou PostShip injoignable (la config locale est effacée quand même).", en: "0 signed out · 2 no key, or PostShip unreachable (the local config is cleared anyway)." },
    depannage: [],
  },
  check: {
    resume: { fr: "Vérifie une URL (ou l'URL de production d'un projet). Compte dans le quota.", en: "Check a URL (or a project's production URL). Counts toward the quota." },
    quota: true,
    usage: "postship check [<url>] [--url <https://…>] [--url …] [--project <id>] [--min-score <n>] [--json] [--quiet] [--junit <fichier>] [--github-annotations]",
    description: { fr: "Le cœur : la même vérification que PostShip fait après un déploiement (l'adresse peut se taper seule, sans --url ni https:// — postship check exemple.fr) — HTTP et ressources, indexabilité, carte sociale, sitemap, certificat, visibilité IA — avec le même Ship Score. Une URL, plusieurs, ou l'URL de production d'un projet. Sort en 1 si une vérification échoue ou si le score est sous le seuil : c'est ce qui bloque une fusion.", en: "The core: the same check PostShip runs after a deploy (the address can be typed alone, without --url or https:// — postship check example.com) — HTTP and assets, indexability, social card, sitemap, certificate, AI visibility — with the same Ship Score. One URL, several, or a project's production URL. Exits 1 when a check fails or the score is below the threshold: that is what blocks a merge." },
    options: [
      { nom: "--url", valeur: "<https://…>", texte: { fr: "L'adresse à vérifier, publique, en https. Répétable : chaque URL compte 1 dans le quota.", en: "The address to check, public, https. Repeatable: each URL counts 1 toward the quota." } },
      { nom: "--project", valeur: "<id>", texte: { fr: "À la place de --url : lit l'URL de production du projet (un appel GET /projects, gratuit) puis la vérifie.", en: "Instead of --url: reads the project's production URL (one free GET /projects call) then checks it." } },
      { nom: "--min-score", valeur: "<n>", texte: { fr: "Sort en 1 si le Ship Score est sous ce seuil, même si tout est passé. Lu aussi dans ./.postship.json.", en: "Exit 1 when the Ship Score is below this threshold, even if everything passed. Also read from ./.postship.json." } },
      { nom: "--json", texte: { fr: "La réponse brute du serveur sur la sortie standard, rien d'autre — pour jq ou un script.", en: "The raw server response on stdout, nothing else — for jq or a script." } },
      { nom: "--quiet", texte: { fr: "Rien sur la sortie standard quand tout passe ; les échecs sur la sortie d'erreur.", en: "Nothing on stdout when everything passes; failures on stderr." } },
      { nom: "--junit", valeur: "<fichier>", texte: { fr: "Écrit un rapport JUnit (un cas par vérification), pour l'onglet Tests de GitLab.", en: "Write a JUnit report (one case per check), for GitLab's Tests tab." } },
      { nom: "--github-annotations", texte: { fr: "Une annotation ::error par échec, sur la pull request. Automatique quand GITHUB_ACTIONS=true ; --github-annotations false pour l'éteindre.", en: "One ::error annotation per failure, on the pull request. Automatic when GITHUB_ACTIONS=true; --github-annotations false turns it off." } },
    ],
    exemples: [
      { cmd: "postship check example.com", texte: { fr: "Le plus court : une adresse, un verdict.", en: "The shortest: one address, one verdict." } },
      { cmd: "postship check --url https://preview-abc.vercel.app --min-score 80", texte: { fr: "La preview d'une pull request, avec un seuil.", en: "A pull request's preview, with a threshold." } },
      { cmd: "postship check --project 3f1c… --json | jq .score", texte: { fr: "La production du projet, le score seul.", en: "The project's production, the score alone." } },
      { cmd: "postship check --url https://a.fr --url https://b.fr --quiet", texte: { fr: "Deux sites d'un coup, silencieux si tout va bien.", en: "Two sites at once, silent when all is well." } },
    ],
    sortie: { fr: "0 tout est passé et le seuil est atteint · 1 une vérification a échoué ou le score est sous le seuil · 2 jeton, quota (429), URL refusée (400), ou PostShip injoignable.", en: "0 everything passed and the threshold is met · 1 a check failed or the score is below the threshold · 2 token, quota (429), refused URL (400), or PostShip unreachable." },
    depannage: [
      { q: { fr: "« Quota mensuel atteint »", en: "“Monthly quota reached”" }, r: { fr: "Le compteur du mois est plein pour votre plan (30, 500 ou 3000). Il repart au premier du mois ; les lectures (projects, incidents, ship, wait, gate) restent illimitées.", en: "The month's counter is full for your plan (30, 500 or 3000). It resets on the first of the month; reads (projects, incidents, ship, wait, gate) stay unlimited." } },
      { q: { fr: "Le score est bon mais le code est 1", en: "The score is fine but the code is 1" }, r: { fr: "Une vérification a échoué : le tableau la marque fail. Le score et le verdict sont deux choses.", en: "A check failed: the table marks it fail. Score and verdict are two different things." } },
    ],
  },
  projects: {
    resume: { fr: "Liste vos projets et leur état.", en: "List your projects and their state." },
    quota: false,
    usage: "postship projects [--json] [--fail-if-red]",
    description: { fr: "Ce que votre clé a le droit de voir : les projets que vous possédez, et ceux où vous êtes membre accepté. Une ligne par projet — identifiant court, nom, URL, verdict du dernier passage, quand.", en: "What your key may see: the projects you own, and those where you are an accepted member. One line per project — short id, name, URL, last run's verdict, when." },
    options: [
      { nom: "--json", texte: { fr: "La liste brute.", en: "The raw list." } },
      { nom: "--fail-if-red", texte: { fr: "Sort en 1 si au moins un projet est en échec — pour un script de garde.", en: "Exit 1 if at least one project is failing — for a watchdog script." } },
    ],
    exemples: [
      { cmd: "postship projects", texte: { fr: "Le tableau.", en: "The table." } },
      { cmd: "postship projects --json | jq -r '.projects[].id'", texte: { fr: "Les identifiants, pour les autres commandes.", en: "The ids, for the other commands." } },
    ],
    sortie: { fr: "0 · 1 avec --fail-if-red si un projet est rouge · 2 jeton refusé ou PostShip injoignable.", en: "0 · 1 with --fail-if-red when a project is red · 2 token refused or PostShip unreachable." },
    depannage: [{ q: { fr: "« Aucun projet. »", en: "“No project.”" }, r: { fr: "La clé appartient à un compte sans projet, ou vous n'êtes membre d'aucun. Vérifiez avec postship whoami.", en: "The key belongs to an account without projects, or you are a member of none. Check with postship whoami." } }],
  },
  incidents: {
    resume: { fr: "Ce qui est en panne sur un projet, et depuis quand.", en: "What is down on a project, and since when." },
    quota: false,
    usage: "postship incidents --project <id> [--fail-if-open] [--json]",
    description: { fr: "Les URLs du projet dont le dernier verdict est mauvais — les incidents au sens de l'application, le fait brut, pas ce que la page de statut raconte. Une ligne par URL : adresse, type de vérification, verdict, depuis quand.", en: "The project's URLs whose last verdict is bad — incidents in the app's sense, the raw fact, not what the status page tells. One line per URL: address, check type, verdict, since when." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet. Ou ./.postship.json, ou POSTSHIP_PROJECT.", en: "The project. Or ./.postship.json, or POSTSHIP_PROJECT." } },
      { nom: "--fail-if-open", texte: { fr: "Sort en 1 s'il y a au moins un incident ouvert.", en: "Exit 1 when at least one incident is open." } },
      { nom: "--json", texte: { fr: "La liste brute.", en: "The raw list." } },
    ],
    exemples: [
      { cmd: "postship incidents -p 3f1c…", texte: { fr: "« Rien d'ouvert. » ou le tableau.", en: "“Nothing open.” or the table." } },
      { cmd: "postship incidents --fail-if-open", texte: { fr: "Dans un dépôt avec ./.postship.json : bloque si quelque chose est en panne.", en: "In a repo with ./.postship.json: block when something is down." } },
    ],
    sortie: { fr: "0 · 1 avec --fail-if-open si un incident est ouvert · 2 projet introuvable, jeton, réseau.", en: "0 · 1 with --fail-if-open when an incident is open · 2 project not found, token, network." },
    depannage: [{ q: { fr: "« Projet introuvable. »", en: "“Project not found.”" }, r: { fr: "Le jeton n'a pas accès à ce projet, ou l'identifiant est faux — la réponse est la même dans les deux cas, exprès.", en: "The token has no access to this project, or the id is wrong — the answer is the same in both cases, on purpose." } }],
  },
  ship: {
    resume: { fr: "Le dernier déploiement de production et son score.", en: "The last production deployment and its score." },
    quota: false,
    usage: "postship ship --project <id> [--require] [--min-score <n>] [--json]",
    description: { fr: "Le dernier déploiement de production suivi — pas une preview — avec son origine (vercel, netlify, cloudflare, generic, empreinte), le commit, la date, le verdict et le Ship Score.", en: "The last tracked production deploy — not a preview — with its origin (vercel, netlify, cloudflare, generic, fingerprint), the commit, the date, the verdict and the Ship Score." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } },
      { nom: "--require", texte: { fr: "Sort en 2 s'il n'y a aucun déploiement suivi — une CI qui refuse de fusionner sans preuve de ship.", en: "Exit 2 when no deploy is tracked — a CI that refuses to merge without proof of a ship." } },
      { nom: "--min-score", valeur: "<n>", texte: { fr: "Sort en 1 si le score du ship est sous ce seuil.", en: "Exit 1 when the ship's score is below this threshold." } },
      { nom: "--json", texte: { fr: "La réponse brute.", en: "The raw response." } },
    ],
    exemples: [
      { cmd: "postship ship -p 3f1c…", texte: { fr: "Une ligne : origine, commit, date, verdict, score.", en: "One line: origin, commit, date, verdict, score." } },
      { cmd: "postship ship -p 3f1c… --require --min-score 80", texte: { fr: "Dans un workflow : la prod doit avoir un ship, et il doit être bon.", en: "In a workflow: production must have a ship, and it must be good." } },
    ],
    sortie: { fr: "0 · 1 ship en échec ou score sous le seuil · 2 aucun ship avec --require, projet introuvable, jeton, réseau.", en: "0 · 1 failing ship or score below threshold · 2 no ship with --require, project not found, token, network." },
    depannage: [{ q: { fr: "« Aucun déploiement de production suivi. »", en: "“No production deployment tracked.”" }, r: { fr: "Aucun hébergeur n'est branché sur ce projet, ou aucune mise en ligne n'a encore été vue. Projet → Intégrations.", en: "No host is connected on this project, or no release has been seen yet. Project → Integrations." } }],
  },
  ships: {
    resume: { fr: "Les derniers déploiements de production.", en: "The last production deployments." },
    quota: false,
    usage: "postship ships --project <id> [--limit <n>] [--json]",
    description: { fr: "L'historique de production, les plus récents d'abord, pour l'humain : vingt par défaut, cent au plus. Les previews n'y sont pas.", en: "The production history, most recent first, for humans: twenty by default, a hundred at most. Previews are not in it." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } },
      { nom: "--limit", valeur: "<n>", texte: { fr: "Combien (20 par défaut, 100 au plus).", en: "How many (20 by default, 100 at most)." } },
      { nom: "--json", texte: { fr: "La liste brute.", en: "The raw list." } },
    ],
    exemples: [{ cmd: "postship ships -p 3f1c… --limit 5", texte: { fr: "Les cinq derniers.", en: "The last five." } }],
    sortie: { fr: "0 · 2 projet introuvable, jeton, réseau.", en: "0 · 2 project not found, token, network." },
    depannage: [],
  },
  urls: {
    resume: { fr: "Les URLs surveillées d'un projet.", en: "The URLs monitored on a project." },
    quota: false,
    usage: "postship urls --project <id> [--json]",
    description: { fr: "Le détail du projet : ses URLs et contrôles (type, actif ou non, dernier verdict, dernier passage), sa page de statut, s'il est en pause.", en: "The project's detail: its URLs and controls (type, enabled or not, last verdict, last run), its status page, whether it is paused." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } },
      { nom: "--json", texte: { fr: "Le détail brut.", en: "The raw detail." } },
    ],
    exemples: [{ cmd: "postship urls -p 3f1c…", texte: { fr: "Le tableau des cibles.", en: "The table of targets." } }],
    sortie: { fr: "0 · 2 projet introuvable, jeton, réseau.", en: "0 · 2 project not found, token, network." },
    depannage: [],
  },
  wait: {
    resume: { fr: "Attend que le dernier ship soit conclu (ou porte un commit), puis rend son verdict.", en: "Wait until the last ship is concluded (or carries a commit), then return its verdict." },
    quota: false,
    usage: "postship wait --project <id> [--head | --sha <abcdef>] [--timeout <s>] [--min-score <n>] [--notify] [--json]",
    description: { fr: "Toutes les quinze secondes, lit le dernier ship de production. Dès qu'il est conclu — verdict posé, score posé — la commande rend ce verdict. Avec --sha, elle attend le ship de ce commit et pas un ship d'hier ; --head prend le commit du dépôt git courant — git push && postship wait --head. Dans un terminal, une roue montre l'attente et le terminal sonne à la fin. Lecture seulement : rien n'est consommé.", en: "Every fifteen seconds, reads the last production ship. As soon as it is concluded — verdict set, score set — the command returns that verdict. With --sha, it waits for that commit's ship, not yesterday's; --head takes the commit of the current git repository — git push && postship wait --head. In a terminal, a spinner shows the wait and the terminal rings at the end. Read only: nothing is consumed." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } },
      { nom: "--head", texte: { fr: "Attend le commit courant du dépôt (git rev-parse HEAD) : celui qu'on vient de pousser.", en: "Wait for the repository's current commit (git rev-parse HEAD): the one just pushed." } },
      { nom: "--sha", valeur: "<abcdef>", texte: { fr: "Le début du commit attendu ($GITHUB_SHA). --sha HEAD vaut --head.", en: "The beginning of the expected commit ($GITHUB_SHA). --sha HEAD equals --head." } },
      { nom: "--timeout", valeur: "<s>", texte: { fr: "Combien de secondes attendre au plus (600).", en: "How many seconds to wait at most (600)." } },
      { nom: "--min-score", valeur: "<n>", texte: { fr: "Sort en 1 si le score du ship est sous ce seuil.", en: "Exit 1 when the ship's score is below this threshold." } },
      { nom: "--notify", texte: { fr: "Une notification du bureau quand le ship est conclu (macOS, Windows, Linux avec notify-send).", en: "A desktop notification when the ship is concluded (macOS, Windows, Linux with notify-send)." } },
      { nom: "--json", texte: { fr: "La réponse brute du ship conclu.", en: "The concluded ship's raw response." } },
    ],
    exemples: [
      { cmd: "git push && postship wait --head --notify", texte: { fr: "Au quotidien : poussez, passez à autre chose, la notification dit si la prod est bonne.", en: "Day to day: push, move on, the notification tells you whether production is good." } },
      { cmd: "postship wait -p 3f1c… --sha \"$GITHUB_SHA\" --timeout 600", texte: { fr: "Après vercel deploy, dans la même job.", en: "After vercel deploy, in the same job." } },
      { cmd: "postship wait --min-score 80", texte: { fr: "Avec ./.postship.json.", en: "With ./.postship.json." } },
    ],
    sortie: { fr: "0 ship conclu et bon · 1 ship en échec ou score sous le seuil · 2 délai écoulé (on n'a pas pu conclure), projet introuvable, jeton, réseau.", en: "0 concluded and good · 1 failing ship or score below threshold · 2 timed out (could not conclude), project not found, token, network." },
    depannage: [{ q: { fr: "Délai écoulé alors que le déploiement est en ligne", en: "Timed out while the deploy is live" }, r: { fr: "PostShip n'a pas vu ce déploiement : l'hébergeur n'est pas branché, ou le commit ne correspond pas (--sha). Projet → Déploiements montre ce qui a été vu.", en: "PostShip did not see this deploy: the host is not connected, or the commit does not match (--sha). Project → Deployments shows what was seen." } },
      { q: { fr: "« --head : pas de dépôt git ici »", en: "“--head: no git repository here”" }, r: { fr: "La commande est lancée hors d'un dépôt, ou git n'est pas installé. Lancez-la depuis le dossier du projet, ou passez --sha.", en: "The command runs outside a repository, or git is not installed. Run it from the project folder, or pass --sha." } },
    ],
  },
  gate: {
    resume: { fr: "Incidents ouverts + dernier ship : la prod est-elle sortable ? Sans quota.", en: "Open incidents + last ship: is production shippable? No quota." },
    quota: false,
    usage: "postship gate --project <id> [--min-score <n>] [--json]",
    description: { fr: "Une ligne dans le workflow qui répond « est-ce que la prod actuelle est sortable ? » : sort en 1 s'il y a un incident ouvert, en 2 s'il n'y a aucun ship suivi, sinon le verdict du dernier ship (avec le seuil). C'est incidents --fail-if-open et ship --require --min-score en un appel, sans brûler de quota.", en: "One line in the workflow that answers “is current production shippable?”: exits 1 when an incident is open, 2 when no ship is tracked, otherwise the last ship's verdict (with the threshold). It is incidents --fail-if-open plus ship --require --min-score in one call, without burning quota." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } },
      { nom: "--min-score", valeur: "<n>", texte: { fr: "Le seuil du ship.", en: "The ship's threshold." } },
      { nom: "--json", texte: { fr: "Incidents et ship, bruts.", en: "Incidents and ship, raw." } },
    ],
    exemples: [{ cmd: "postship gate -p 3f1c… --min-score 80", texte: { fr: "Avant de fusionner sur main.", en: "Before merging into main." } }],
    sortie: { fr: "0 rien d'ouvert, ship bon · 1 incident ouvert, ship en échec ou sous le seuil · 2 aucun ship, projet introuvable, jeton, réseau.", en: "0 nothing open, good ship · 1 open incident, failing ship or below threshold · 2 no ship, project not found, token, network." },
    depannage: [],
  },
  watch: {
    resume: { fr: "Les incidents ouverts en direct, avec une sonnerie à chaque changement. Terminal seulement.", en: "Open incidents live, with a ring on every change. Terminal only." },
    quota: false,
    usage: "postship watch [--project <id>] [--interval <s>] [--notify]",
    description: { fr: "Le tableau des incidents ouverts, redessiné toutes les trente secondes jusqu'à Ctrl+C — d'un projet, ou de tous vos projets actifs quand aucun n'est choisi. Quand un incident s'ouvre ou se ferme, le terminal sonne et la ligne s'ajoute au fil de la séance, sous le tableau ; --notify envoie aussi une notification du bureau. De quoi la laisser ouverte dans un onglet. Refusé quand CI=true : une watch dans un workflow tourne pour rien — utilisez incidents --fail-if-open ou gate.", en: "The open incidents table, redrawn every thirty seconds until Ctrl+C — for one project, or all your active projects when none is chosen. When an incident opens or closes, the terminal rings and the line joins the session feed under the table; --notify also sends a desktop notification. Something to leave open in a tab. Refused when CI=true: a watch in a workflow runs for nothing — use incidents --fail-if-open or gate." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Un seul projet (sinon : tous les projets actifs, vingt au plus).", en: "A single project (otherwise: all active projects, twenty at most)." } },
      { nom: "--interval", valeur: "<s>", texte: { fr: "Toutes les combien de secondes relire (30 par défaut, 15 au moins).", en: "How often to read again, in seconds (30 by default, 15 at least)." } },
      { nom: "--notify", texte: { fr: "Une notification du bureau à chaque incident ouvert ou résolu.", en: "A desktop notification for every incident opened or resolved." } },
    ],
    exemples: [
      { cmd: "postship watch --notify", texte: { fr: "Tous les projets, toute la journée, dans un onglet.", en: "Every project, all day, in a tab." } },
      { cmd: "postship watch -p 3f1c… --interval 15", texte: { fr: "Pendant une mise en ligne délicate.", en: "During a delicate release." } },
    ],
    sortie: { fr: "0 à Ctrl+C · 2 CI=true, pas de terminal, projet introuvable, jeton, réseau (au premier relevé ; ensuite, une coupure s'affiche sans quitter).", en: "0 on Ctrl+C · 2 CI=true, no terminal, project not found, token, network (on the first read; afterwards, an outage is shown without quitting)." },
    depannage: [{ q: { fr: "Aucune notification du bureau", en: "No desktop notification" }, r: { fr: "Sur Linux, installez notify-send (libnotify) ; sur Windows et macOS, vérifiez que les notifications du terminal ne sont pas coupées. La sonnerie du terminal, elle, part toujours.", en: "On Linux, install notify-send (libnotify); on Windows and macOS, check that the terminal's notifications are not muted. The terminal ring always goes off." } }],
  },
  status: {
    resume: { fr: "Le compte, les projets, les incidents ouverts et le dernier ship en un écran.", en: "Account, projects, open incidents and last ship on one screen." },
    quota: false,
    usage: "postship status [--project <id>] [--json]",
    description: { fr: "Le tableau de bord, d'un coup, puis la main rend au shell — tapé seul, postship ouvre l'interface plein écran, qui suit la même chose en direct. Qui parle (plan, quota, clé), chaque projet avec son état et le nombre d'incidents ouverts, et pour le projet courant — celui de ./.postship.json ou de --project — les incidents ouverts et le dernier déploiement de production.", en: "The dashboard, at once, then back to the shell — typed alone, postship opens the full-screen interface, which follows the same things live. Who is speaking (plan, quota, key), each project with its state and number of open incidents, and for the current project — the one in ./.postship.json or --project — open incidents and the last production deploy." },
    options: [
      { nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet à détailler.", en: "The project to detail." } },
      { nom: "--json", texte: { fr: "Tout, brut.", en: "Everything, raw." } },
    ],
    exemples: [
      { cmd: "postship status -p 3f1c…", texte: { fr: "Un projet en détail : incidents ouverts et dernier ship.", en: "One project in detail: open incidents and last ship." } },
      { cmd: "postship status --json | jq '.projects[] | select(.openIncidents > 0) | .name'", texte: { fr: "Les projets qui ont un incident ouvert.", en: "The projects with an open incident." } },
    ],
    sortie: { fr: "0 · 1 un incident ouvert ou un ship en échec sur le projet courant · 2 jeton, réseau.", en: "0 · 1 an open incident or a failing ship on the current project · 2 token, network." },
    depannage: [],
  },
  open: {
    resume: { fr: "Ouvre le projet dans le navigateur.", en: "Open the project in the browser." },
    quota: false,
    usage: "postship open [--project <id>] [apercu|incidents|deploys|urls|performance|reglages]",
    description: { fr: "L'Aperçu du projet courant dans le navigateur — ou une page nommée : incidents, deploys, urls, performance, reglages. Sans projet, l'app.", en: "The current project's Overview in the browser — or a named page: incidents, deploys, urls, performance, reglages. Without a project, the app." },
    options: [{ nom: "--project, -p", valeur: "<id>", texte: { fr: "Le projet.", en: "The project." } }],
    exemples: [
      { cmd: "postship open", texte: { fr: "L'Aperçu.", en: "The Overview." } },
      { cmd: "postship open incidents -p 3f1c…", texte: { fr: "Les incidents de ce projet.", en: "This project's incidents." } },
    ],
    sortie: { fr: "0 · 2 projet introuvable, ou pas de navigateur à lancer (l'adresse est affichée).", en: "0 · 2 project not found, or no browser to launch (the address is printed)." },
    depannage: [
      { q: { fr: "En SSH, ou dans un script, je veux juste l'adresse.", en: "Over SSH, or in a script, I just want the address." }, r: { fr: "POSTSHIP_NO_BROWSER=1 : l'adresse est écrite, rien n'est lancé, code 0. La même variable vaut pour login (le lien est affiché) et docs.", en: "POSTSHIP_NO_BROWSER=1: the address is printed, nothing is launched, exit 0. The same variable applies to login (the link is printed) and docs." } },
    ],
  },
  whoami: {
    resume: { fr: "Le plan, le quota et la clé en cours.", en: "The current plan, quota and key." },
    quota: false,
    usage: "postship whoami [--json]",
    description: { fr: "Qui parle : le plan du compte, le quota de vérifications du mois (utilisé, limite, restant), et la clé — son préfixe, son nom, son dernier usage. Rien du compte lui-même.", en: "Who is speaking: the account's plan, this month's check quota (used, limit, remaining), and the key — its prefix, name, last use. Nothing of the account itself." },
    options: [{ nom: "--json", texte: { fr: "Brut.", en: "Raw." } }],
    exemples: [{ cmd: "postship whoami", texte: { fr: "« plan pro · quota 12/500 · jeton psk_ab12cd… »", en: "“plan pro · quota 12/500 · token psk_ab12cd…”" } }],
    sortie: { fr: "0 · 2 jeton refusé ou réseau.", en: "0 · 2 token refused or network." },
    depannage: [],
  },
  doctor: {
    resume: { fr: "Node, réseau, PostShip joignable, clé acceptée.", en: "Node, network, PostShip reachable, key accepted." },
    quota: false,
    usage: "postship doctor",
    description: { fr: "Quatre lignes : la version de Node (18 au moins), fetch, PostShip joignable (un 401 sans clé est bon signe), et si une clé est posée, si elle est acceptée et combien de projets elle lit. N'appelle jamais /check.", en: "Four lines: the Node version (18 or newer), fetch, PostShip reachable (a 401 without a key is a good sign), and if a key is set, whether it is accepted and how many projects it reads. Never calls /check." },
    options: [],
    exemples: [{ cmd: "postship doctor", texte: { fr: "Avant d'ouvrir un ticket.", en: "Before opening a ticket." } }],
    sortie: { fr: "0 tout va · 2 quelque chose ne va pas (dit lequel).", en: "0 all good · 2 something is wrong (says which)." },
    depannage: [],
  },
  init: {
    resume: { fr: "Écrit ./.postship.json : le projet et le seuil. Jamais la clé.", en: "Write ./.postship.json: the project and the threshold. Never the key." },
    quota: false,
    usage: "postship init [--project <id>] [--min-score <n>]",
    description: { fr: "Dans un terminal, liste vos projets et vous laisse choisir au clavier ; sinon prend --project. Écrit ./.postship.json — commitable — avec le projet et le seuil (80 par défaut). La clé, elle, reste dans POSTSHIP_TOKEN ou ~/.config/postship : jamais dans un fichier versionné.", en: "In a terminal, lists your projects and lets you pick with the keyboard; otherwise takes --project. Writes ./.postship.json — committable — with the project and the threshold (80 by default). The key stays in POSTSHIP_TOKEN or ~/.config/postship: never in a versioned file." },
    options: [
      { nom: "--project", valeur: "<id>", texte: { fr: "Le projet, sans passer par la liste.", en: "The project, skipping the list." } },
      { nom: "--min-score", valeur: "<n>", texte: { fr: "Le seuil à écrire (80).", en: "The threshold to write (80)." } },
    ],
    exemples: [
      { cmd: "postship init", texte: { fr: "Choisir dans la liste, flèches et Entrée.", en: "Pick from the list, arrows and Enter." } },
      { cmd: "postship init --project 3f1c… --min-score 90", texte: { fr: "Sans question, pour un script.", en: "No question asked, for a script." } },
    ],
    sortie: { fr: "0 fichier écrit · 2 pas de terminal et pas de --project, identifiant invalide, jeton, réseau.", en: "0 file written · 2 no terminal and no --project, invalid id, token, network." },
    depannage: [],
  },
  update: {
    resume: { fr: "Met la CLI à jour, avec le gestionnaire qui l'a installée.", en: "Update the CLI, with the package manager that installed it." },
    quota: false,
    usage: "postship update [--check]",
    description: {
      fr: "Lit la dernière version publiée sur npm et, si elle est plus récente, la réinstalle avec le gestionnaire qui a installé la CLI — npm i -g postship@latest, ou son équivalent pnpm, yarn ou bun. La connexion est gardée : la clé reste dans ~/.config/postship. Une CLI lancée par npx, depuis la source ou dans l'action GitHub n'est pas touchée : la commande dit quoi faire. Depuis l'interface (/update), elle se ferme, la mise à jour se fait, puis on relance postship.",
      en: "Reads the latest version published on npm and, when it is newer, reinstalls it with the package manager that installed the CLI — npm i -g postship@latest, or its pnpm, yarn or bun equivalent. You stay signed in: the key stays in ~/.config/postship. A CLI run through npx, from source or in the GitHub action is left alone: the command says what to do. From the interface (/update), it closes, the update runs, then run postship again.",
    },
    options: [{ nom: "--check", texte: { fr: "Dit seulement si une version plus récente existe, sans rien installer.", en: "Only says whether a newer version exists, without installing anything." } }],
    exemples: [
      { cmd: "postship update", texte: { fr: "La dernière version, en une commande.", en: "The latest version, in one command." } },
      { cmd: "postship update --check", texte: { fr: "Savoir s'il y a du nouveau, sans rien changer.", en: "Find out whether there is something new, without changing anything." } },
    ],
    sortie: { fr: "0 à jour, ou mise à jour faite · 2 registre npm injoignable, CLI hors installation globale, ou échec du gestionnaire (droits).", en: "0 up to date, or updated · 2 npm registry unreachable, CLI not globally installed, or the package manager failed (permissions)." },
    depannage: [{ q: { fr: "« La mise à jour a échoué » avec EACCES", en: "“The update failed” with EACCES" }, r: { fr: "Sur macOS ou Linux, le dossier global de npm appartient souvent à root : sudo npm i -g postship@latest, ou un gestionnaire de versions de Node (nvm, fnm) qui installe dans votre dossier.", en: "On macOS or Linux, npm's global folder often belongs to root: sudo npm i -g postship@latest, or a Node version manager (nvm, fnm) that installs in your home folder." } }],
  },
  uninstall: {
    resume: { fr: "Révoque la clé, efface la configuration et désinstalle la CLI.", en: "Revoke the key, delete the configuration and uninstall the CLI." },
    quota: false,
    usage: "postship uninstall [--yes]",
    description: {
      fr: "Trois gestes, dans l'ordre : la clé de ce terminal est révoquée chez PostShip (comme postship logout), ~/.config/postship est effacé (clé, réglages et historique de l'interface, cache de version), puis le paquet est retiré avec le gestionnaire qui l'a installé. Une confirmation est demandée dans un terminal ; --yes pour un script. Les fichiers ./.postship.json de vos dépôts et une clé posée dans POSTSHIP_TOKEN ne sont pas touchés.",
      en: "Three steps, in order: this terminal's key is revoked on PostShip (like postship logout), ~/.config/postship is deleted (key, interface settings and history, version cache), then the package is removed with the package manager that installed it. A confirmation is asked in a terminal; --yes for a script. The ./.postship.json files in your repositories and a key set in POSTSHIP_TOKEN are left alone.",
    },
    options: [{ nom: "--yes", texte: { fr: "Sans confirmation (obligatoire hors d'un terminal).", en: "Without confirmation (required outside a terminal)." } }],
    exemples: [
      { cmd: "postship uninstall", texte: { fr: "Tout retirer, proprement.", en: "Remove everything, cleanly." } },
      { cmd: "postship uninstall --yes", texte: { fr: "Dans un script de nettoyage de poste.", en: "In a machine clean-up script." } },
    ],
    sortie: { fr: "0 désinstallé (ou renoncé à la confirmation) · 2 hors terminal sans --yes, ou échec du gestionnaire.", en: "0 uninstalled (or declined at the confirmation) · 2 outside a terminal without --yes, or the package manager failed." },
    depannage: [{ q: { fr: "« Le fichier de commandes est introuvable » dans cmd.exe", en: "“The batch file cannot be found” in cmd.exe" }, r: { fr: "Sans conséquence : cmd.exe relit le raccourci postship.cmd qui vient d'être supprimé. PowerShell et Windows Terminal ne l'affichent pas.", en: "Harmless: cmd.exe reads again the postship.cmd shim that was just removed. PowerShell and Windows Terminal do not show it." } }],
  },
  completion: {
    resume: { fr: "L'autocomplétion des commandes et options pour votre shell.", en: "Command and option completion for your shell." },
    quota: false,
    usage: "postship completion bash|zsh|fish|powershell",
    description: { fr: "Écrit le script de complétion sur la sortie standard ; à charger dans votre profil. Les commandes, leurs options, et les pages de postship open.", en: "Prints the completion script on stdout; source it from your profile. The commands, their options, and postship open's pages." },
    options: [],
    exemples: [
      { cmd: "postship completion zsh >> ~/.zshrc", texte: { fr: "zsh.", en: "zsh." } },
      { cmd: "postship completion bash >> ~/.bashrc", texte: { fr: "bash.", en: "bash." } },
      { cmd: "postship completion fish > ~/.config/fish/completions/postship.fish", texte: { fr: "fish.", en: "fish." } },
      { cmd: "postship completion powershell >> $PROFILE", texte: { fr: "PowerShell.", en: "PowerShell." } },
    ],
    sortie: { fr: "0 · 2 shell inconnu.", en: "0 · 2 unknown shell." },
    depannage: [],
  },
  docs: {
    resume: { fr: "Ouvre la documentation d'une commande sur postship.fr.", en: "Open a command's documentation on postship.fr." },
    quota: false,
    usage: "postship docs [commande]",
    description: { fr: "postship.fr/docs/cli, ou la page de la commande donnée, dans le navigateur. Sans navigateur, l'adresse est affichée.", en: "postship.fr/docs/cli, or the given command's page, in the browser. Without a browser, the address is printed." },
    options: [],
    exemples: [{ cmd: "postship docs wait", texte: { fr: "La page de wait.", en: "wait's page." } }],
    sortie: { fr: "0 · 2 commande inconnue.", en: "0 · 2 unknown command." },
    depannage: [],
  },
};

const ORDRE = ["login", "logout", "status", "check", "projects", "incidents", "ship", "ships", "urls", "wait", "gate", "watch", "open", "whoami", "doctor", "init", "update", "uninstall", "completion", "docs"];

/**
 * Les commandes rangées par usage, pour l'aide générale et le menu « / »
 * de la console (28 sept. 2026). Chaque commande de ORDRE y figure une
 * fois — le test le vérifie.
 */
const GROUPES = [
  { fr: "Au quotidien", en: "Day to day", commandes: ["status", "watch", "wait", "check", "incidents", "open"] },
  { fr: "Projets et déploiements", en: "Projects and deploys", commandes: ["projects", "urls", "ship", "ships", "gate"] },
  { fr: "Compte et outils", en: "Account and tools", commandes: ["login", "logout", "whoami", "init", "update", "uninstall", "doctor", "completion", "docs"] },
];

const PAGES_OPEN = ["apercu", "incidents", "deploys", "urls", "performance", "reglages"];

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

/**
 * La clé ne part qu'en https (audit du 28 sept. 2026) : POSTSHIP_API pointé
 * sur une adresse en http l'aurait envoyée en clair sur le réseau. Seule
 * exception, la machine elle-même (localhost), pour développer.
 */
function adresseSure(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// Les caractères de contrôle : C0 (sauf tabulation et saut de ligne), DEL, C1.
const CONTROLES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Ce qui vient du serveur ne pilote jamais le terminal (audit du 28 sept.
 * 2026). Le détail d'une vérification reprend des morceaux du site
 * vérifié — un titre, un en-tête — : une séquence d'échappement glissée
 * là changerait le titre de la fenêtre, écrirait dans le presse-papiers
 * (OSC 52) ou maquillerait un lien. Chaque chaîne reçue perd ses
 * caractères de contrôle avant d'être lue par une commande.
 */
function nettoyerTexte(valeur) {
  return String(valeur).replace(CONTROLES, "");
}

function nettoyerDonnees(valeur, profondeur = 0) {
  if (typeof valeur === "string") return nettoyerTexte(valeur);
  if (profondeur > 20 || valeur === null || typeof valeur !== "object") return valeur;
  if (Array.isArray(valeur)) return valeur.map((v) => nettoyerDonnees(v, profondeur + 1));
  const sortie = {};
  for (const [cle, v] of Object.entries(valeur)) sortie[nettoyerTexte(cle)] = nettoyerDonnees(v, profondeur + 1);
  return sortie;
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
  if (!adresseSure(baseUrl())) {
    throw new ErreurCli(t("POSTSHIP_API doit être une adresse en https : la clé ne part jamais en clair.", "POSTSHIP_API must be an https address: the key never travels in clear text."), 2);
  }
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
    const payload = nettoyerDonnees(await reponse.json().catch(() => null));
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
  if (!jeton) throw new ErreurCli(t("Aucune clé : postship login, ou posez POSTSHIP_TOKEN.", "No key: postship login, or set POSTSHIP_TOKEN."), 2);
  const r = await appel(methode, chemin, { ...options, jeton });
  if (!r.ok) {
    // Les phrases `error` du serveur restent telles quelles ; un 401 dit
    // en plus comment s'en sortir (clé révoquée, ou expirée après 90 jours).
    let phrase = r.payload && typeof r.payload.error === "string" ? r.payload.error : t("PostShip a répondu {0}.", "PostShip answered {0}.", r.status);
    if (r.status === 401) phrase += t(" Relancez postship login.", " Run postship login again.");
    const e = new ErreurCli(phrase, 2);
    e.status = r.status;
    e.payload = r.payload;
    throw e;
  }
  return r.payload;
}

/**
 * Français si LANG commence par fr, sinon anglais. Sans LANG — le cas
 * de Windows —, la langue du système (28 sept. 2026) : un Windows en
 * français avait une CLI en anglais.
 */
function langue() {
  let systeme = "";
  try {
    systeme = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    // pas d'Intl : l'anglais
  }
  const l = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || systeme;
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
//
// L'identité (28 sept. 2026) : la marque <> en bleu ardoise — les deux
// chevrons du logo —, un symbole par verdict (✓ × ! – ◌), une jauge pour
// le Ship Score, une courbe pour son histoire, et une roue qui tourne sur
// la sortie d'erreur pendant qu'on attend. Aucun cadre ni trait décoratif,
// comme dans l'app. Sans terminal (CI, tube, --json), tout redevient du
// texte brut : ce qu'un script lit ne change pas.


const ESC = "\x1b";
const CODES = { reset: `${ESC}[0m`, dim: `${ESC}[2m`, red: `${ESC}[31m`, green: `${ESC}[32m`, yellow: `${ESC}[33m`, bold: `${ESC}[1m`, blue: `${ESC}[34m` };

// Les teintes de l'app (globals.css) : signal, ok, warn, danger — celles
// du thème sombre sur un terminal sombre, celles du thème clair sur un
// terminal clair (le bleu pâle du sombre ne se lit pas sur du blanc).
// En 24 bits quand le terminal le dit, en 256 couleurs sinon. `fond` et
// `choix` : le fond d'une ligne choisie dans l'interface plein écran.
const PALETTES = {
  sombre: { signal: [143, 176, 220], green: [74, 158, 112], yellow: [196, 164, 64], red: [217, 99, 90], choix: [32, 42, 56], trait: [58, 58, 58] },
  clair: { signal: [47, 95, 158], green: [42, 122, 75], yellow: [138, 106, 16], red: [179, 54, 47], choix: [227, 236, 247], trait: [212, 212, 212] },
  // Quand le terminal ne dit pas sa couleur de fond : des teintes moyennes,
  // lisibles sur les deux, et la ligne choisie en vidéo inverse.
  neutre: { signal: [84, 126, 190], green: [52, 140, 92], yellow: [170, 132, 30], red: [200, 76, 68], trait: [128, 128, 128] },
};
const TEINTES_256 = { signal: 110, green: 72, yellow: 178, red: 167, choix: 236, trait: 238 };
const TEINTES_256_CLAIR = { signal: 25, green: 28, yellow: 136, red: 124, choix: 254, trait: 252 };
let theme = "sombre";

/** Le thème du terminal : « sombre » (par défaut), « clair », ou « neutre » quand on ne sait pas. */
function definirTheme(t) {
  theme = t === "clair" || t === "neutre" ? t : "sombre";
}

function couleursActives() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.CI === "true") return false;
  return !!process.stdout.isTTY;
}

function profondeur() {
  const ct = String(process.env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit" || process.env.WT_SESSION || process.env.TERM_PROGRAM === "vscode" || process.env.TERM_PROGRAM === "iTerm.app") return 24;
  // Windows 10 1809 et plus comprend les couleurs 24 bits, Windows Terminal aussi.
  if (process.platform === "win32" && Number(String(release()).split(".")[2] ?? 0) >= 17763) return 24;
  if (String(process.env.TERM ?? "").includes("256")) return 8;
  return 4;
}

function codeCouleur(couleur, plan = 38) {
  const p = profondeur();
  const rgb = PALETTES[theme][couleur];
  if (p === 24 && rgb) return `${ESC}[${plan};2;${rgb.join(";")}m`;
  const t256 = (theme === "clair" ? TEINTES_256_CLAIR : TEINTES_256)[couleur];
  if (p === 8 && t256) return `${ESC}[${plan};5;${t256}m`;
  if (plan === 48) return couleur === "choix" ? `${ESC}[7m` : "";
  return CODES[couleur === "signal" ? "blue" : couleur === "trait" ? "dim" : couleur] ?? "";
}

/** Un fond de couleur (la ligne choisie d'une liste), rien sans couleurs. */
function surFond(couleur, texte) {
  if (!couleursActives()) return texte;
  // Le fond survit aux « reset » intérieurs : on le repose après chacun.
  const code = codeCouleur(couleur, 48);
  return `${code}${String(texte).replaceAll(CODES.reset, `${CODES.reset}${code}`)}${CODES.reset}`;
}

function peindre(couleur, texte) {
  if (!couleursActives()) return texte;
  if (couleur === "bold" || couleur === "dim" || couleur === "reset") return `${CODES[couleur]}${texte}${CODES.reset}`;
  return `${codeCouleur(couleur)}${texte}${CODES.reset}`;
}

/**
 * Le terminal sait-il dessiner ✓ et ⠋ ? Partout sauf l'ancienne console
 * de Windows et la console texte de Linux. POSTSHIP_ASCII=1 force l'ASCII.
 *
 * Windows 11 (build 22000 et plus) ouvre cmd et PowerShell dans Windows
 * Terminal — sans toujours poser WT_SESSION quand le terminal est celui
 * par défaut : on s'y fie au numéro de build (retour du 28 sept. 2026,
 * une console en « +---+ » sur un Windows 11).
 */
function unicode() {
  if (process.env.POSTSHIP_ASCII) return false;
  if (process.platform !== "win32") return process.env.TERM !== "linux";
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuTask || process.env.TERMINAL_EMULATOR || String(process.env.TERM ?? "").startsWith("xterm")) return true;
  const build = Number(String(release()).split(".")[2] ?? 0);
  return build >= 22000;
}

/**
 * <> postship — la marque, en tête des écrans qu'on lit. Les chevrons
 * restent en ASCII : ❮❯ manque à Cascadia et Consolas, et la police de
 * secours décale la ligne.
 */
function marque(suite = "") {
  return `${peindre("signal", peindre("bold", "<>"))} ${peindre("bold", "postship")}${suite ? `  ${suite}` : ""}`;
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
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

/** Coupe à n colonnes visibles, couleurs comprises, avec « … » quand il en manque. */
function tronquer(s, n) {
  const texte = String(s);
  if (visible(texte).length <= n) return texte;
  if (n <= 1) return "…".slice(0, Math.max(0, n));
  let sortie = "";
  let vus = 0;
  for (const morceau of texte.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(morceau)) {
      sortie += morceau;
      continue;
    }
    for (const c of morceau) {
      if (vus >= n - 1) break;
      sortie += c;
      vus++;
    }
    if (vus >= n - 1) break;
  }
  return `${sortie}…${texte.includes("\x1b[") ? "\x1b[0m" : ""}`;
}

/** Complète d'espaces jusqu'à n colonnes visibles. */
function completer(s, n) {
  return `${s}${" ".repeat(Math.max(0, n - visible(s).length))}`;
}

const MARQUE = { pass: "pass", fail: "fail", error: "error", skip: "skip", muted: "off" };
const TEINTE = { pass: "green", fail: "red", error: "red", skip: "dim", muted: "dim" };
// × plutôt que ✗ : présent dans toutes les polices à chasse fixe, il
// garde les colonnes alignées (✗ tombe dans une police de secours).
const SYMBOLES = { pass: ["✓", "+"], fail: ["×", "x"], error: ["!", "!"], skip: ["–", "-"], muted: ["◌", "o"] };

/** Le symbole seul d'un verdict, en couleur : ✓ × ! – ◌. */
function symbole(outcome) {
  const s = SYMBOLES[outcome] ?? ["·", "."];
  return peindre(TEINTE[outcome] ?? "dim", unicode() ? s[0] : s[1]);
}

/** « ✓ pass », « × fail » : le symbole et le mot de l'API, alignés. */
function verdict(outcome) {
  return `${symbole(outcome)} ${peindre(TEINTE[outcome] ?? "dim", (MARQUE[outcome] ?? String(outcome ?? "—")).padEnd(5))}`;
}

/** La couleur d'un Ship Score : vert dès 90, jaune dès 70, rouge dessous. */
function teinteScore(score) {
  if (typeof score !== "number") return "dim";
  return score >= 90 ? "green" : score >= 70 ? "yellow" : "red";
}

function traits() {
  return unicode() ? ["━", "─"] : ["=", "-"];
}

/** « 92 ━━━━━━━━━─ » : le score et sa jauge sur dix. */
function jauge(score, largeur = 10) {
  if (typeof score !== "number") return peindre("dim", "—");
  const plein = Math.max(0, Math.min(largeur, Math.round((score / 100) * largeur)));
  const [p, v] = traits();
  return `${peindre("bold", String(score))} ${peindre(teinteScore(score), p.repeat(plein))}${peindre("dim", v.repeat(largeur - plein))}`;
}

/** Une ligne de quota : « 12/300 ━━───────── ». */
function jaugeQuota(used, limit, largeur = 10) {
  const ratio = limit > 0 ? used / limit : 0;
  const plein = Math.max(0, Math.min(largeur, Math.round(ratio * largeur)));
  const [p, v] = traits();
  const teinte = ratio >= 0.9 ? "red" : ratio >= 0.7 ? "yellow" : "signal";
  return `${used}/${limit} ${peindre(teinte, p.repeat(plein))}${peindre("dim", v.repeat(largeur - plein))}`;
}

/** ▁▃▅▇ : l'histoire des scores, du plus ancien au plus récent. */
function courbe(scores) {
  const [barres, vide] = unicode() ? ["▁▂▃▄▅▆▇█", "·"] : ["_.-=+*#@", "."];
  return scores
    .map((s) => (typeof s === "number" ? peindre(teinteScore(s), barres[Math.max(0, Math.min(7, Math.floor((s / 100) * 7.999)))]) : peindre("dim", vide)))
    .join("");
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

/** « 45 s », « 12 min », « 2 h 14 », « 3 j 4 h » : une durée lisible. */
function duree(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  const j = Math.floor(h / 24);
  return langue() === "fr" ? `${j} j ${h % 24} h` : `${j} d ${h % 24} h`;
}

/** Le nom du plan tel que l'app l'écrit : « Pro Plus », pas « pro_plus ». */
function nomPlan(plan) {
  return { free: langue() === "fr" ? "Découverte" : "Discovery", pro: "Pro", pro_plus: "Pro Plus" }[plan] ?? String(plan ?? "—");
}

function courtId(id) {
  return String(id ?? "").slice(0, 4) + (String(id ?? "").length > 4 ? "…" : "");
}

/** L'hôte et le chemin, sans https:// : ce qu'on lit d'un coup d'œil. */
function adresseCourte(url) {
  return String(url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * La roue qui tourne pendant une attente — sur la sortie d'erreur, et
 * seulement quand c'est un terminal : stdout reste propre pour un tube,
 * et une CI ne reçoit pas cinquante lignes de ⠋⠙⠹.
 */
function roue(texte) {
  const actif = !!process.stderr.isTTY && process.env.CI !== "true" && !process.env.POSTSHIP_NO_SPINNER;
  let courant = texte;
  if (!actif) return { actif: false, maj: (t) => void (courant = t), fin: () => {} };
  const images = unicode() ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["|", "/", "-", "\\"];
  let i = 0;
  const dessiner = () => {
    process.stderr.write(`\r${ESC}[2K  ${peindre("signal", images[i++ % images.length])} ${masquer(courant)}`);
  };
  dessiner();
  const minuterie = setInterval(dessiner, 90);
  minuterie.unref?.();
  return {
    actif: true,
    maj(t) {
      courant = t;
      dessiner();
    },
    fin() {
      clearInterval(minuterie);
      process.stderr.write(`\r${ESC}[2K`);
    },
  };
}

/** Le « ding » du terminal, pour une attente qui se termine ou un incident qui s'ouvre. */
function sonner() {
  if (process.stderr.isTTY && process.env.CI !== "true") process.stderr.write("\x07");
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

// ---- notifier.mjs
// Une notification du bureau, sans dépendance (28 sept. 2026) : pour
// `postship wait --notify` (le ship est conclu, revenez) et
// `postship watch --notify` (un incident s'ouvre ou se ferme).
//
// macOS : osascript ; Linux : notify-send ; Windows : un toast par
// PowerShell. Le titre et le texte ne sont jamais collés dans une ligne
// de commande : ils passent en arguments (osascript, notify-send) ou en
// variables d'environnement (PowerShell) — une URL ou un libellé venus du
// serveur ne peuvent donc rien exécuter. Rend false quand rien n'a pu
// être lancé ; la sonnerie du terminal reste, elle, toujours là.


const TOAST_WINDOWS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t=$x.GetElementsByTagName('text')",
  "[void]$t.Item(0).AppendChild($x.CreateTextNode($env:POSTSHIP_NOTIF_TITRE))",
  "[void]$t.Item(1).AppendChild($x.CreateTextNode($env:POSTSHIP_NOTIF_TEXTE))",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("; ");

function notifierBureau(titre, texte) {
  if (process.env.POSTSHIP_NO_BROWSER || process.env.CI === "true") return false;
  const t1 = masquer(titre).slice(0, 120);
  const t2 = masquer(texte).slice(0, 240);
  try {
    const p =
      process.platform === "darwin"
        ? spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t1, t2], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", TOAST_WINDOWS], { stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, POSTSHIP_NOTIF_TITRE: t1, POSTSHIP_NOTIF_TEXTE: t2 } })
          : spawn("notify-send", ["--app-name=PostShip", "--", t1, t2], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

// ---- navigateur.mjs
// Ouvrir une adresse dans le navigateur, sans dépendance : le gestionnaire
// d'URL de Windows, `open` sur macOS, `xdg-open` ailleurs. Rend false quand
// rien n'a pu être lancé (serveur, conteneur) : l'appelant affiche l'adresse.
// POSTSHIP_NO_BROWSER=1 : n'ouvre jamais rien (scripts, tests, SSH).
//
// Jamais par `cmd /c start` (audit du 28 sept. 2026) : cmd relit la ligne,
// et une adresse venue du serveur contenant « & » y lançait une commande.
// Seules les adresses http(s) passent, et sans shell.


function ouvrirNavigateur(url) {
  if (process.env.POSTSHIP_NO_BROWSER) return false;
  let adresse;
  try {
    adresse = new URL(String(url));
  } catch {
    return false;
  }
  if (adresse.protocol !== "https:" && adresse.protocol !== "http:") return false;
  url = adresse.toString();
  try {
    const p =
      process.platform === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true, windowsHide: true })
        : process.platform === "darwin"
          ? spawn("open", [url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** « MacBook-de-Camille » → « MacBook de Camille » ; le nom de la machine, lisible. */
function nomMachine() {
  return hostname().replace(/\.local$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 80) || "cette machine";
}

// ---- console.mjs
// Les outils de saisie de l'interface plein écran (src/cli/interface.mjs) :
// découper une ligne comme un shell, lire les touches du mode brut,
// proposer les commandes derrière « / », retrouver un projet par son nom,
// garder l'historique des commandes tapées.





/** Les commandes propres à l'interface, en plus de celles de la CLI. */
const SESSION_CONSOLE = {
  projet: { fr: "Choisit le projet affiché, par son nom.", en: "Choose the displayed project, by name." },
  reglages: { fr: "Le projet par défaut et les notifications du bureau.", en: "Default project and desktop notifications." },
  notifier: { fr: "Notifications du bureau quand un incident s'ouvre ou se ferme (on/off).", en: "Desktop notifications when an incident opens or closes (on/off)." },
  theme: { fr: "Couleurs pour un terminal clair ou sombre (clair/sombre/auto).", en: "Colours for a light or dark terminal (clair/sombre/auto)." },
  effacer: { fr: "Vide la vue Sortie.", en: "Clear the Output view." },
  aide: { fr: "Les raccourcis et les commandes.", en: "Shortcuts and commands." },
  quitter: { fr: "Quitte l'interface (q).", en: "Quit the interface (q)." },
};
const ALIAS_CONSOLE = { project: "projet", settings: "reglages", réglages: "reglages", notify: "notifier", help: "aide", "?": "aide", clear: "effacer", exit: "quitter", quit: "quitter", q: "quitter" };
/** Ce qui n'a pas de sens dans l'interface : watch (elle suit déjà), completion (un script pour le shell). */
const HORS_CONSOLE = new Set(["watch", "completion"]);
const HISTORIQUE_MAX = 500;

/** « check "mon site.fr" --min-score 80 » → ["check", "mon site.fr", "--min-score", "80"]. */
function decouperLigne(ligne) {
  const sortie = [];
  let courant = "";
  let guillemet = null;
  let entame = false;
  for (const c of String(ligne)) {
    if (guillemet) {
      if (c === guillemet) guillemet = null;
      else courant += c;
      continue;
    }
    if (c === '"' || c === "'") {
      guillemet = c;
      entame = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (courant || entame) sortie.push(courant);
      courant = "";
      entame = false;
      continue;
    }
    courant += c;
  }
  if (courant || entame) sortie.push(courant);
  return sortie;
}

const SEQUENCES_TOUCHES = { "[A": "up", "[B": "down", "[C": "right", "[D": "left", OA: "up", OB: "down", OC: "right", OD: "left", "[H": "home", "[F": "end", OH: "home", OF: "end", "[1~": "home", "[4~": "end", "[7~": "home", "[8~": "end", "[3~": "delete", "[5~": "pageup", "[6~": "pagedown", "[Z": "shift-tab" };

/**
 * Les touches d'un morceau lu en mode brut. Un Échap seul arrive seul :
 * les terminaux envoient une séquence (flèche, Suppr…) d'un bloc. Le
 * décodeur de Node, lui, garde un Échap isolé en attente de la touche
 * suivante — d'où celui-ci.
 */
function lireTouches(donnees) {
  const s = String(donnees);
  const touches = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\x1b") {
      const m = s.slice(i + 1).match(/^(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/);
      if (m) {
        const code = m[1].replace(/^\[1;\d+([A-DHF])$/, "[$1");
        touches.push({ nom: SEQUENCES_TOUCHES[code] ?? "inconnue" });
        i += 1 + m[1].length;
      } else {
        touches.push({ nom: "escape" });
        i += 1;
      }
      continue;
    }
    if (c === "\r" || c === "\n") {
      touches.push({ nom: "return" });
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (c === "\x7f" || c === "\b") {
      touches.push({ nom: "backspace" });
      i += 1;
      continue;
    }
    if (c === "\t") {
      touches.push({ nom: "tab" });
      i += 1;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 32) {
      touches.push({ nom: String.fromCharCode(code + 96), ctrl: true });
      i += 1;
      continue;
    }
    let j = i;
    while (j < s.length && s.charCodeAt(j) >= 32 && s[j] !== "\x7f") j++;
    touches.push({ texte: s.slice(i, j) });
    i = j;
  }
  return touches;
}

/** Replie un texte à la largeur, sur les espaces. */
function plier(texte, largeur) {
  const lignes = [];
  let courante = "";
  for (const mot of String(texte).split(/\s+/)) {
    if (courante && (courante + " " + mot).length > largeur) {
      lignes.push(courante);
      courante = mot;
    } else courante = courante ? `${courante} ${mot}` : mot;
  }
  if (courante) lignes.push(courante);
  return lignes;
}

/** Un projet par son nom (exact, puis début, puis morceau) ou le début de son identifiant. */
function trouverProjet(projets, requete) {
  const q = String(requete ?? "").trim().toLowerCase();
  if (!q) return null;
  return (
    projets.find((p) => p.name.toLowerCase() === q) ??
    projets.find((p) => String(p.id).toLowerCase().startsWith(q)) ??
    projets.find((p) => p.name.toLowerCase().startsWith(q)) ??
    projets.find((p) => p.name.toLowerCase().includes(q)) ??
    null
  );
}

/** Les entrées du menu « / » : les commandes de la CLI par groupe, puis celles de l'interface. */
function entreesConsole(l = langue()) {
  const liste = [];
  for (const g of GROUPES) for (const nom of g.commandes) if (!HORS_CONSOLE.has(nom)) liste.push({ nom, texte: COMMANDES[nom].resume[l], valeur: `/${nom}` });
  for (const [nom, texte] of Object.entries(SESSION_CONSOLE)) liste.push({ nom, texte: texte[l], valeur: `/${nom}`, session: true, argument: nom === "projet" });
  return liste;
}

/** Ce que la liste propose pour la saisie en cours, ou rien. */
function suggestionsConsole(saisie, options = {}) {
  const { projets = [], l = langue() } = /** @type {{ projets?: { id: string, name: string, url: string }[], l?: "fr" | "en" }} */ (options);
  const projet = saisie.match(/^\/?(?:projet|project)\s+(.*)$/i);
  if (projet) {
    const q = projet[1].toLowerCase();
    return projets.map((p) => ({ nom: p.name, texte: adresseCourte(p.url), valeur: `/projet ${p.name}` })).filter((e) => e.nom.toLowerCase().includes(q));
  }
  const page = saisie.match(/^\/?open\s+(\S*)$/i);
  if (page) return PAGES_OPEN.filter((p) => p.startsWith(page[1].toLowerCase())).map((p) => ({ nom: p, texte: "", valeur: `/open ${p}` }));
  const theme = saisie.match(/^\/?theme\s+(\S*)$/i);
  if (theme) return ["clair", "sombre", "auto"].filter((x) => x.startsWith(theme[1].toLowerCase())).map((x) => ({ nom: x, texte: "", valeur: `/theme ${x}` }));
  if (/^\/?\S*$/.test(saisie)) {
    const q = saisie.replace(/^\//, "").toLowerCase();
    return entreesConsole(l).filter((e) => e.nom.startsWith(q) || (q && Object.entries(ALIAS_CONSOLE).some(([a, cible]) => cible === e.nom && a.startsWith(q))));
  }
  return [];
}

function cheminHistorique() {
  return join(dirname(cheminConfig()), "historique");
}

function lireHistorique() {
  try {
    return readFileSync(cheminHistorique(), "utf8").split("\n").filter(Boolean).slice(-HISTORIQUE_MAX);
  } catch {
    return [];
  }
}

function ecrireHistorique(lignes) {
  try {
    mkdirSync(dirname(cheminHistorique()), { recursive: true, mode: 0o700 });
    // Jamais une clé dans l'historique, même collée par erreur ; lisible du seul propriétaire.
    writeFileSync(cheminHistorique(), lignes.slice(-HISTORIQUE_MAX).map(masquer).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // pas grave : l'historique est un confort
  }
}

// ---- commands/login.mjs
// `postship login` — connecter la CLI au compte, comme on connecte un
// téléviseur : un code court à comparer, une page qui autorise, la clé
// qui arrive. La clé s'écrit dans ~/.config/postship/config.json (0600),
// jamais ailleurs.






function lireConfig() {
  try {
    return JSON.parse(readFileSync(cheminConfig(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * La configuration (la clé) s'écrit lisible du seul propriétaire dès sa
 * création — 0600, dossier 0700 —, pas une fois écrite (audit du 28 sept.
 * 2026) : entre les deux, n'importe quel compte de la machine pouvait la
 * lire. Écrite à côté puis renommée : un arrêt au milieu ne laisse jamais
 * une configuration tronquée.
 */
function ecrireConfig(valeurs) {
  const chemin = cheminConfig();
  mkdirSync(dirname(chemin), { recursive: true, mode: 0o700 });
  const provisoire = `${chemin}.${process.pid}.tmp`;
  writeFileSync(provisoire, JSON.stringify(valeurs, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(provisoire, 0o600);
  } catch {
    // Windows : pas de mode POSIX ; le dossier utilisateur fait office.
  }
  renameSync(provisoire, chemin);
  return chemin;
}

async function login(args, { dormir = (ms) => new Promise((r) => setTimeout(r, ms)), maintenant = () => Date.now() } = {}) {
  const machine = typeof une(args.machine) === "string" ? une(args.machine) : nomMachine();
  const r = await appel("POST", "/api/cli/autoriser/demander", { corps: { machine }, timeoutMs: 15_000 });
  if (!r.ok || !r.payload?.device_code) {
    throw new ErreurCli(r.payload?.error ?? t("PostShip a répondu {0}.", "PostShip answered {0}.", r.status), 2);
  }
  const { device_code: deviceCode, user_code: userCode, verification_url_complete: lienComplet, verification_url: lien, expires_in: expiresIn, interval } = r.payload;

  ecrire();
  ecrire(`  ${marque("login")}`);
  ecrire();
  const [libCode, libLien] = [t("Le code de ce terminal", "This terminal's code"), t("À ouvrir", "Open")];
  const col = Math.max(libCode.length, libLien.length) + 3;
  ecrire(`  ${libCode.padEnd(col)}${peindre("signal", peindre("bold", userCode))}`);
  ecrire(`  ${libLien.padEnd(col)}${lienComplet ?? lien}`);
  ecrire();
  ecrire(peindre("dim", `  ${t("Vérifiez que le navigateur affiche le même code, puis « Autoriser ce terminal ».", "Check that the browser shows the same code, then “Authorize this terminal”.")}`));
  ecrire();
  if (args["no-browser"] !== true && process.stdout.isTTY) {
    if (!ouvrirNavigateur(lienComplet ?? lien)) ecrire(peindre("dim", `  ${t("Aucun navigateur ici : copiez l'adresse ailleurs.", "No browser here: copy the address elsewhere.")}`));
  }
  const attente = roue(t("En attente de l'autorisation dans le navigateur… (dix minutes au plus)", "Waiting for the authorization in the browser… (ten minutes at most)"));

  const fin = maintenant() + (Number(expiresIn) || 600) * 1000;
  const pas = Math.max(2, Number(interval) || 3) * 1000;
  try {
    for (;;) {
      await dormir(pas);
      const j = await appel("POST", "/api/cli/autoriser/jeton", { corps: { device_code: deviceCode }, timeoutMs: 15_000 });
      if (j.ok && j.payload?.token) {
        attente.fin();
        const config = lireConfig();
        const chemin = ecrireConfig({ ...config, token: j.payload.token, prefix: j.payload.prefix, machine, api: baseUrl(), connecteLe: new Date().toISOString() });
        ecrire(`  ${symbole("pass")} ${peindre("bold", t("Terminal connecté", "Terminal connected"))}`);
        ecrire(peindre("dim", `    ${t("clé {0}… · {1}", "key {0}… · {1}", j.payload.prefix, chemin)}`));
        if (process.env.POSTSHIP_TOKEN) ecrire(peindre("yellow", `  ${t("POSTSHIP_TOKEN est posé dans l'environnement et passe devant ce fichier.", "POSTSHIP_TOKEN is set in the environment and takes precedence over this file.")}`));
        ecrire();
        const ensuite = t("Et maintenant", "What next");
        ecrire(`  ${ensuite}   postship ${peindre("dim", t("— le tableau de bord", "— the dashboard"))}`);
        ecrire(`  ${" ".repeat(ensuite.length)}   postship init ${peindre("dim", t("— lier ce dossier à un projet", "— link this folder to a project"))}`);
        ecrire();
        return 0;
      }
      if (j.status === 410) throw new ErreurCli(t("Le code a expiré (dix minutes). Relancez postship login.", "The code expired (ten minutes). Run postship login again."), 2);
      if (j.status !== 428) throw new ErreurCli(j.payload?.error ?? t("PostShip a répondu {0}.", "PostShip answered {0}.", j.status), 2);
      if (maintenant() >= fin) throw new ErreurCli(t("Le code a expiré (dix minutes). Relancez postship login.", "The code expired (ten minutes). Run postship login again."), 2);
    }
  } finally {
    attente.fin();
  }
}

/** `postship logout` : révoque la clé de la config (pas celle de l'environnement), puis l'efface. */
async function logout() {
  const config = lireConfig();
  if (!config.token) {
    if (process.env.POSTSHIP_TOKEN) throw new ErreurCli(t("La clé vient de POSTSHIP_TOKEN, pas de la CLI : retirez la variable, ou révoquez la clé dans Réglages de l'espace → API.", "The key comes from POSTSHIP_TOKEN, not from the CLI: unset the variable, or revoke the key in Workspace settings → API."), 2);
    throw new ErreurCli(t("Aucune clé enregistrée par la CLI.", "No key saved by the CLI."), 2);
  }
  let revoquee = true;
  try {
    // La clé de la config, explicitement : même si POSTSHIP_TOKEN est posé.
    const r = await appel("POST", "/api/cli/deconnecter", { jeton: config.token, timeoutMs: 15_000 });
    revoquee = r.ok || r.status === 401;
  } catch {
    revoquee = false;
  }
  const { token: _t, prefix: _p, machine: _m, connecteLe: _c, ...reste } = config;
  void _t;
  void _p;
  void _m;
  void _c;
  ecrireConfig(reste);
  if (!revoquee) throw new ErreurCli(t("Config locale effacée, mais PostShip est injoignable : révoquez la clé dans Réglages de l'espace → API.", "Local config cleared, but PostShip is unreachable: revoke the key in Workspace settings → API."), 2);
  ecrire(`${symbole("pass")} ${t("Déconnecté : la clé est révoquée et retirée de {0}.", "Signed out: the key is revoked and removed from {0}.", cheminConfig())}`);
  return 0;
}

/** Le jeton effectif, pour `status` : d'où il vient. */
function origineJeton() {
  if (process.env.POSTSHIP_TOKEN) return "env";
  if (lireJeton()) return "config";
  return null;
}

// ---- methodes-connexion.mjs
// Les deux façons de connecter la CLI, sans rien imprimer : l'interface
// plein écran et `postship login` les affichent chacune à leur manière.
//   - le navigateur : le flux d'appareil (un code court, une page qui
//     autorise, la clé qui arrive) ;
//   - une clé d'API : une clé psk_… déjà créée dans Réglages de l'espace → API, vérifiée
//     avant d'être enregistrée.
// Le QR code et l'email + code (28 sept. 2026) ont été retirés le jour
// même, à la demande : deux chemins de plus à défendre pour un geste rare.


const EXPIREE = () => t("Le code a expiré (dix minutes). Recommencez.", "The code expired (ten minutes). Start again.");

/** Une demande d'autorisation : le code à comparer et l'adresse à ouvrir (ou à scanner). */
async function demarrerAppareil(machine) {
  const r = await appel("POST", "/api/cli/autoriser/demander", { corps: { machine }, timeoutMs: 15_000 });
  if (!r.ok || !r.payload?.device_code) throw new ErreurCli(r.payload?.error ?? t("PostShip a répondu {0}.", "PostShip answered {0}.", r.status), 2);
  const p = r.payload;
  return { deviceCode: p.device_code, userCode: p.user_code, lien: p.verification_url, lienComplet: p.verification_url_complete ?? p.verification_url, expireDans: Number(p.expires_in) || 600, intervalle: Math.max(2, Number(p.interval) || 3) };
}

/** Attend l'approbation dans l'app ; rend { token, prefix }. `annule()` arrête l'attente. */
async function attendreAppareil(demande, { dormir = (ms) => new Promise((r) => setTimeout(r, ms)), maintenant = () => Date.now(), annule = () => false } = {}) {
  const fin = maintenant() + demande.expireDans * 1000;
  for (;;) {
    await dormir(demande.intervalle * 1000);
    if (annule()) throw new ErreurCli(t("Annulé.", "Cancelled."), 2);
    const j = await appel("POST", "/api/cli/autoriser/jeton", { corps: { device_code: demande.deviceCode }, timeoutMs: 15_000 });
    if (j.ok && j.payload?.token) return { token: j.payload.token, prefix: j.payload.prefix };
    if (j.status === 410) throw new ErreurCli(EXPIREE(), 2);
    if (j.status !== 428) throw new ErreurCli(j.payload?.error ?? t("PostShip a répondu {0}.", "PostShip answered {0}.", j.status), 2);
    if (maintenant() >= fin) throw new ErreurCli(EXPIREE(), 2);
  }
}

/** Vérifie une clé collée : la forme, puis PostShip ; rend { token, prefix, plan }. */
async function verifierCleApi(brute) {
  const cle = String(brute).trim();
  if (!/^psk_[A-Za-z0-9_-]{16,}$/.test(cle)) throw new ErreurCli(t("Ce n'est pas une clé PostShip : elle commence par psk_ (Réglages de l'espace → API).", "This is not a PostShip key: it starts with psk_ (Workspace settings → API)."), 2);
  const r = await appel("GET", "/api/v1/me", { jeton: cle, timeoutMs: 15_000 });
  if (r.status === 401) throw new ErreurCli(t("Clé refusée : révoquée, expirée ou mal copiée.", "Key refused: revoked, expired or miscopied."), 2);
  if (!r.ok) throw new ErreurCli(r.payload?.error ?? t("PostShip a répondu {0}.", "PostShip answered {0}.", r.status), 2);
  return { token: cle, prefix: r.payload?.token?.prefix ?? cle.slice(0, 10), plan: r.payload?.plan ?? null };
}

/** Écrit la clé dans la configuration (0600), à côté des réglages déjà là. */
function enregistrerConnexion({ token, prefix, machine }) {
  return ecrireConfig({ ...lireConfig(), token, prefix, machine, api: baseUrl(), connecteLe: new Date().toISOString() });
}

// ---- version.mjs
// L'avis de nouvelle version : au plus une fois par jour, une ligne
// discrète sur la sortie d'erreur — jamais de mise à jour automatique
// (c'est `postship update` qui installe, quand on le demande).
// Lu sur le registre npm, mémorisé à côté de la config. Muet en CI, sans
// terminal, ou en --json : rien ne doit polluer une sortie qu'un script lit.





const UN_JOUR = 86_400_000;

function cheminCacheVersion() {
  return join(dirname(cheminConfig()), "version-check.json");
}

/** a < b, sur « x.y.z » ; false si l'une n'est pas une version. */
function plusRecente(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN) || pa.length < 3 || pb.length < 3) return false;
  for (let i = 0; i < 3; i++) {
    if (pb[i] > pa[i]) return true;
    if (pb[i] < pa[i]) return false;
  }
  return false;
}

/**
 * La dernière version publiée sur npm : celle du cache si elle a moins
 * d'un jour, sinon celle du registre. `forcer` interroge toujours le
 * registre (postship update) et rend null s'il ne répond pas.
 */
async function versionPubliee({ forcer = false, delaiMs = 1500 } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cheminCacheVersion(), "utf8"));
  } catch {
    // premier passage
  }
  if (!forcer && cache.verifieLe && Date.now() - new Date(cache.verifieLe).getTime() <= UN_JOUR) return cache.derniere ?? null;
  let derniere = null;
  try {
    const controleur = new AbortController();
    const minuterie = setTimeout(() => controleur.abort(), delaiMs);
    const r = await fetch("https://registry.npmjs.org/postship/latest", { signal: controleur.signal, headers: { Accept: "application/json" } });
    clearTimeout(minuterie);
    // Une version, rien d'autre : le registre ne fait pas écrire n'importe quoi au terminal.
    if (r.ok) {
      const v = String((await r.json()).version ?? "");
      derniere = /^\d+\.\d+\.\d+$/.test(v) ? v : null;
    }
  } catch {
    // le registre ne répond pas : on retentera plus tard
  }
  try {
    mkdirSync(dirname(cheminCacheVersion()), { recursive: true });
    writeFileSync(cheminCacheVersion(), JSON.stringify({ verifieLe: new Date().toISOString(), derniere: derniere ?? cache.derniere ?? null }));
  } catch {
    // pas grave
  }
  return forcer ? derniere : (derniere ?? cache.derniere ?? null);
}

async function avisDeVersion({ json = false } = {}) {
  if (json || process.env.CI === "true" || !process.stderr.isTTY || process.env.POSTSHIP_NO_UPDATE_NOTICE || VERSION.startsWith("__")) return;
  const derniere = await versionPubliee();
  if (derniere && plusRecente(VERSION, derniere)) {
    console.error(peindre("dim", t("postship {0} est disponible (vous avez {1}) : postship update", "postship {0} is available (you have {1}): postship update", derniere, VERSION)));
  }
}

// ---- ui/ecran.mjs
// L'écran de l'interface plein écran : l'écran alternatif du terminal (ce
// qui était affiché revient intact en quittant), et une image recomposée à
// chaque changement dont seules les lignes modifiées sont réécrites, entre
// les bornes de la « sortie synchronisée » (?2026) quand le terminal la
// connaît — pas de clignotement pendant qu'une ligne s'écrit.

/** L'écran : sa taille, l'entrée et la sortie de l'écran alternatif, et le dessin d'une image. */
function creerEcran(sortie) {
  const ecrire = sortie.write.bind(sortie);
  let precedent = [];
  return {
    ecrire,
    taille: () => ({ w: Math.max(20, sortie.columns || 80), h: Math.max(8, sortie.rows || 24) }),
    entrer() {
      ecrire("\x1b[?1049h\x1b[?25l\x1b[2J");
    },
    sortir() {
      ecrire("\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l");
    },
    /** Après un redimensionnement : tout est à réécrire. */
    invalider() {
      precedent = [];
      ecrire("\x1b[2J");
    },
    peindre(lignes, h) {
      let s = "\x1b[?2026h";
      for (let i = 0; i < h; i++) {
        const l = lignes[i] ?? "";
        if (precedent[i] === l) continue;
        s += `\x1b[${i + 1};1H${l}\x1b[0m\x1b[K`;
      }
      s += "\x1b[?2026l";
      precedent = lignes.slice(0, h);
      ecrire(s);
    },
  };
}

/**
 * La couleur de fond du terminal, demandée par OSC 11 (xterm, Windows
 * Terminal, iTerm, VS Code…) : « clair », « sombre », ou null s'il ne
 * répond pas dans le délai.
 */
function detecterTheme(entree, ecrire, delaiMs = 250) {
  return new Promise((resolve) => {
    let tampon = "";
    const finir = (valeur) => {
      clearTimeout(minuterie);
      entree.off("data", surReponse);
      resolve(valeur);
    };
    const surReponse = (d) => {
      tampon += String(d);
      const m = tampon.match(/\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      if (!m) return;
      const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h.slice(0, 2), 16));
      finir(0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "clair" : "sombre");
    };
    const minuterie = setTimeout(() => finir(null), delaiMs);
    entree.on("data", surReponse);
    ecrire("\x1b]11;?\x1b\\");
  });
}

// ---- ui/donnees.mjs
// Les données de l'interface : le compte, les projets, leurs incidents
// ouverts et leur dernier ship, relus en direct ; le détail du projet
// affiché, lu à la demande. Et ce qui a changé d'un relevé à l'autre —
// un incident ouvert ou résolu, un ship vérifié —, rendu sous forme
// d'événements que l'interface affiche et sonne.

const PROJETS_SUIVIS_UI = 20;
const FRAICHEUR_DETAILS_MS = 60_000;

/** Un ship dont le verdict est posé (ni en attente, ni en cours). */
function shipConclu(ship) {
  return !!ship && ship.outcome !== null && ship.outcome !== undefined && ship.outcome !== "pending" && ship.outcome !== "running";
}

/**
 * L'ordre de la liste : les projets qui ont un incident ouvert d'abord
 * (les plus touchés en tête), puis ceux dont la dernière vérification a
 * échoué, puis les autres par nom ; les projets en pause à la fin.
 */
function trierProjets(projets, ouverts) {
  const rang = (p) => (p.paused ? 3 : (ouverts.get(p.id)?.length ?? 0) > 0 ? 0 : p.status === "fail" || p.status === "error" ? 1 : 2);
  return [...projets].sort((a, b) => rang(a) - rang(b) || (ouverts.get(b.id)?.length ?? 0) - (ouverts.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name));
}

/** Les projets dont le nom ou l'adresse contient le filtre, sans casse ni accents. */
function filtrerProjets(projets, filtre) {
  const simple = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = simple(filtre).trim();
  if (!q) return projets;
  return projets.filter((p) => simple(p.name).includes(q) || simple(p.url).includes(q));
}

/**
 * « Prêt à livrer ? » — la même réponse que `postship gate` : un incident
 * ouvert ferme la barrière, un dernier ship en échec aussi, et un score
 * sous le seuil de ./.postship.json.
 */
function verdictLivraison({ paused, ouverts, ship, minScore }) {
  if (paused) return { etat: "pause" };
  if (ouverts > 0) return { etat: "bloque", raison: "incidents", n: ouverts };
  if (!ship) return { etat: "inconnu" };
  if (!shipConclu(ship)) return { etat: "attente" };
  if (ship.outcome === "fail" || ship.outcome === "error") return { etat: "bloque", raison: "ship" };
  if (typeof minScore === "number" && typeof ship.score === "number" && ship.score < minScore) return { etat: "bloque", raison: "score", score: ship.score, minScore };
  return { etat: "pret" };
}

/** Les incidents apparus et disparus entre deux relevés, projet par projet (seulement ceux déjà connus). */
function comparerIncidents(anciens, nouveaux, projets) {
  const cle = (i) => `${i.url}|${i.kind ?? ""}`;
  const evenements = [];
  for (const p of projets) {
    if (!anciens.has(p.id) || !nouveaux.has(p.id)) continue;
    const avant = new Set((anciens.get(p.id) ?? []).map(cle));
    const apres = new Set((nouveaux.get(p.id) ?? []).map(cle));
    for (const i of nouveaux.get(p.id) ?? []) if (!avant.has(cle(i))) evenements.push({ type: "ouvert", projet: p, url: i.url });
    for (const i of anciens.get(p.id) ?? []) if (!apres.has(cle(i))) evenements.push({ type: "resolu", projet: p, url: i.url });
  }
  return evenements;
}

/** Les ships qui viennent d'être conclus : un nouveau commit, ou le même dont le verdict vient de tomber. */
function comparerShips(anciens, nouveaux, projets) {
  const evenements = [];
  for (const p of projets) {
    if (!anciens.has(p.id) || !nouveaux.has(p.id)) continue;
    const avant = anciens.get(p.id);
    const apres = nouveaux.get(p.id);
    if (!shipConclu(apres)) continue;
    const nouveau = !avant || avant.sha !== apres.sha || avant.at !== apres.at;
    if (nouveau || !shipConclu(avant)) evenements.push({ type: "ship", projet: p, ship: apres });
  }
  return evenements;
}

/**
 * Le magasin : `rafraichir` relit tout (un seul relevé à la fois — un
 * appel pendant qu'un autre court attend celui-là), `chargerDetails` lit
 * le détail d'un projet, gardé une minute.
 */
function creerDonnees() {
  const d = { moi: null, projets: [], ouverts: new Map(), ships: new Map(), details: new Map(), majLe: null, horsLigne: null };
  let enCours = null;
  let tours = 0;

  async function relire({ annoncer }) {
    const [moi, liste] = await Promise.all([appelAuthentifie("GET", "/api/v1/me"), appelAuthentifie("GET", "/api/v1/projects")]);
    const projets = liste?.projects ?? [];
    const suivis = projets.filter((p) => !p.paused).slice(0, PROJETS_SUIVIS_UI);
    // Les derniers ships une fois sur deux (toutes les minutes) : une alerte de ship n'a pas besoin des trente secondes.
    const avecShips = tours % 2 === 0;
    tours++;
    const [incidents, ships] = await Promise.all([
      Promise.all(suivis.map((p) => appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(p.id)}/incidents`).catch(() => null))),
      avecShips ? Promise.all(suivis.map((p) => appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(p.id)}/last-ship`).catch(() => null))) : Promise.resolve(null),
    ]);
    const ouverts = new Map(suivis.map((p, i) => [p.id, incidents[i] ? (incidents[i].incidents ?? []) : (d.ouverts.get(p.id) ?? [])]));
    const shipsLus = ships ? new Map(suivis.map((p, i) => [p.id, ships[i] ? (ships[i].lastShip ?? null) : (d.ships.get(p.id) ?? null)])) : d.ships;
    const evenements = annoncer && d.moi ? [...comparerIncidents(d.ouverts, ouverts, suivis), ...(ships ? comparerShips(d.ships, shipsLus, suivis) : [])] : [];
    Object.assign(d, { moi, projets, ouverts, ships: shipsLus, majLe: Date.now(), horsLigne: null });
    // Le dernier ship fraîchement lu vaut aussi pour le détail déjà chargé.
    if (ships) for (const [id, s] of shipsLus) if (d.details.has(id)) d.details.get(id).ship = s;
    return { evenements, refuse: false };
  }

  async function rafraichir({ annoncer = true } = {}) {
    if (enCours) return enCours;
    enCours = relire({ annoncer })
      .catch((err) => {
        if (err?.status === 401) return { evenements: [], refuse: true };
        d.horsLigne = err?.message ?? String(err);
        return { evenements: [], refuse: false };
      })
      .finally(() => {
        enCours = null;
      });
    return enCours;
  }

  async function chargerDetails(p, forcer = false) {
    if (!p) return;
    const deja = d.details.get(p.id);
    if (deja && !forcer && Date.now() - deja.lu < FRAICHEUR_DETAILS_MS) return;
    const id = encodeURIComponent(p.id);
    const [ls, sh, pr] = await Promise.all([
      appelAuthentifie("GET", `/api/v1/projects/${id}/last-ship`).catch(() => null),
      appelAuthentifie("GET", `/api/v1/projects/${id}/ships?limit=20`).catch(() => null),
      appelAuthentifie("GET", `/api/v1/projects/${id}`).catch(() => null),
    ]);
    d.details.set(p.id, { ship: ls?.lastShip ?? null, ships: sh?.ships ?? [], urls: pr?.project?.urls ?? null, statusPage: pr?.project?.statusPage ?? null, lu: Date.now() });
  }

  function oublier() {
    Object.assign(d, { moi: null, projets: [], ouverts: new Map(), ships: new Map(), details: new Map(), majLe: null, horsLigne: null });
    tours = 0;
  }

  return { d, rafraichir, chargerDetails, oublier };
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

/** La ligne d'un ship : « dernier ship  vercel  a1b2c3d  il y a 2 h  ✓ pass  92 ━━━━━━━━━─ ». */
function ligneShip(ship, libelle = t("dernier ship", "last ship")) {
  return [
    libelle ? peindre("dim", libelle) : "",
    ship.provider ?? "—",
    peindre("bold", String(ship.sha ?? "").slice(0, 7) || "—"),
    relatif(ship.at),
    verdict(ship.outcome).trim(),
    ship.score !== null && ship.score !== undefined ? jauge(ship.score) : "",
  ]
    .filter(Boolean)
    .join("  ");
}

// ---- ui/vues.mjs
// Le rendu de l'interface : chaque écran est une fonction pure de l'état
// (celui de l'interface, `e`, et celui des données, `d`) vers des lignes
// de la largeur de l'écran. Aucune écriture ici — interface.mjs peint.





const VUES_UI = [
  { id: "apercu", fr: "Aperçu", en: "Overview" },
  { id: "incidents", fr: "Incidents", en: "Incidents" },
  { id: "ships", fr: "Déploiements", en: "Deploys" },
  { id: "urls", fr: "URLs", en: "URLs" },
  { id: "sortie", fr: "Sortie", en: "Output" },
];
const METHODES_UI = [
  { id: "navigateur", fr: "Avec le navigateur de cet ordinateur", en: "With this computer's browser" },
  { id: "cle", fr: "Avec une clé d'API", en: "With an API key" },
];
const LARGEUR_MIN_UI = 50;
const HAUTEUR_MIN_UI = 14;

/** Les projets tels que la liste les montre : triés, puis filtrés. */
function projetsAffiches(e, d) {
  return filtrerProjets(trierProjets(d.projets, d.ouverts), e.filtre);
}

/** Les lignes qu'on peut choisir dans une vue (Tab) : incidents, URLs, déploiements. */
function rangeesVue(vue, p, d) {
  if (!p) return [];
  if (vue === "incidents") return (d.ouverts.get(p.id) ?? []).map((i) => ({ url: i.url, incident: i }));
  if (vue === "urls") return (d.details.get(p.id)?.urls ?? []).map((u) => ({ url: u.url, cible: u }));
  if (vue === "ships") return (d.details.get(p.id)?.ships ?? []).map((s) => ({ ship: s }));
  return [];
}

function creerVues({ L, U }) {
  const B = U ? { v: "│", h: "─" } : { v: "|", h: "-" };
  const ROUE = U ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["|", "/", "-", "\\"];
  const heure = (ms) => new Date(ms).toLocaleTimeString(L === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const touche = (k, texte) => `${peindre("bold", k)} ${peindre("dim", texte)}`;
  const curseur = () => (couleursActives() ? "\x1b[7m \x1b[27m" : "_");
  const largeurBloc = (w) => Math.min(72, w - 5);
  const para = (texte, w, couleur) => plier(texte, largeurBloc(w)).map((l) => (couleur ? peindre(couleur, l) : l));

  // --- les écrans centrés : chargement, connexion, réglages -------------

  function centre(lignesBloc, pied, w, h) {
    const lb = Math.min(72, w - 4);
    const marge = " ".repeat(Math.max(1, Math.floor((w - lb) / 2)));
    const bloc = [`${peindre("signal", peindre("bold", "<>"))} ${peindre("bold", "postship")}`, "", "", ...lignesBloc];
    const haut = Math.max(1, Math.floor((h - bloc.length - 2) / 2));
    const lignes = new Array(h).fill("");
    bloc.forEach((l, i) => {
      if (haut + i < h - 2) lignes[haut + i] = marge + tronquer(l, lb);
    });
    if (pied) lignes[h - 1] = ` ${tronquer(pied, w - 2)}`;
    return lignes;
  }

  function liste(options, index) {
    return options.map((o, i) => {
      const actif = i === index;
      const texte = `${actif ? peindre("signal", U ? "›" : ">") : " "} ${actif ? peindre("bold", o) : o}`;
      return actif ? surFond("choix", ` ${completer(texte, 44)} `) : ` ${texte}`;
    });
  }

  function champ(valeur, masque) {
    const affiche = masque ? (U ? "•" : "*").repeat(Math.min(valeur.length, 40)) : valeur;
    return [`  ${affiche}${curseur()}`, `  ${peindre("trait", B.h.repeat(46))}`];
  }

  function etat(e, w) {
    if (e.occupe) return [`  ${peindre("signal", ROUE[e.image % ROUE.length])} ${e.occupe}`];
    if (e.erreur) return para(`${U ? "×" : "x"} ${e.erreur}`, w, "red");
    if (e.message) return para(e.message, w, "dim");
    return [];
  }

  const piedChoix = () => `${touche(U ? "↑↓" : "Up/Down", t("choisir", "choose"))}   ${touche(t("Entrée", "Enter"), t("valider", "confirm"))}   ${touche("q", t("quitter", "quit"))}`;

  function ecranConnexion(e, w, h) {
    return centre([...para(t("Comment voulez-vous vous connecter ?", "How do you want to sign in?"), w), "", ...liste(METHODES_UI.map((m) => m[L]), e.methode), "", ...etat(e, w)], piedChoix(), w, h);
  }

  function ecranNavigateur(e, w, h) {
    const pied = `${touche(t("Échap", "Esc"), t("revenir", "back"))}   ${touche("q", t("quitter", "quit"))}`;
    const dm = e.demande;
    if (!dm) return centre([...etat(e, w)], pied, w, h);
    return centre(
      [
        ...para(t("Le navigateur s'ouvre sur postship.fr. Vérifiez que le code est le même, puis autorisez.", "The browser opens on postship.fr. Check that the code is the same, then authorize."), w),
        "",
        `  ${peindre("signal", peindre("bold", dm.userCode.split("").join(" ")))}`,
        "",
        ...para(t("Rien ne s'ouvre ? Allez sur {0}", "Nothing opens? Go to {0}", dm.lienComplet), w, "dim"),
        "",
        ...etat(e, w),
      ],
      pied,
      w,
      h,
    );
  }

  function ecranCle(e, w, h) {
    const pied = `${touche(t("Entrée", "Enter"), t("valider", "confirm"))}   ${touche(t("Échap", "Esc"), t("revenir", "back"))}`;
    return centre([t("Collez votre clé d'API", "Paste your API key"), "", ...champ(e.saisie, true), "", ...para(t("Elle commence par psk_ ; créez-la dans Réglages de l'espace → API sur postship.fr. Elle ne s'affiche pas ici.", "It starts with psk_; create it in Workspace settings → API on postship.fr. It is not shown here."), w, "dim"), "", ...etat(e, w)], pied, w, h);
  }

  function ecranProjetDefaut(e, d, w, h) {
    const options = [t("Tous les projets", "Every project"), ...trierProjets(d.projets, d.ouverts).map((p) => p.name)];
    return centre([...para(t("Quel projet afficher en premier ?", "Which project should open first?"), w), "", ...liste(options.slice(0, Math.max(3, h - 14)), e.choix), "", ...para(t("Modifiable plus tard : d sur un projet, ou / puis reglages.", "Change it later: d on a project, or / then reglages."), w, "dim")], piedChoix(), w, h);
  }

  function ecranNotifications(e, w, h) {
    return centre([...para(t("Une notification du bureau quand un incident s'ouvre ou se ferme, ou qu'un ship est vérifié ?", "A desktop notification when an incident opens or closes, or a ship is checked?"), w), "", ...liste([t("Oui", "Yes"), t("Non, la sonnerie et la ligne du bas suffisent", "No, the ring and the bottom line are enough")], e.choix), "", ...para(t("Modifiable plus tard : n dans l'interface.", "Change it later: n in the interface."), w, "dim")], piedChoix(), w, h);
  }

  // --- l'écran principal -------------------------------------------------

  function panneauProjets(e, d, lw, n) {
    const affiches = projetsAffiches(e, d);
    const titre = e.filtreEdition
      ? ` ${peindre("signal", "f")} ${e.filtre}${curseur()}`
      : e.filtre
        ? ` ${peindre("dim", t("Filtre", "Filter"))} ${peindre("bold", e.filtre)} ${peindre("dim", `${affiches.length}/${d.projets.length}`)}`
        : ` ${peindre("dim", t("Projets", "Projects"))}${d.projets.length ? peindre("dim", `  ${d.projets.length}`) : ""}`;
    const l = [titre, ""];
    if (d.projets.length === 0) {
      if (d.horsLigne) l.push(` ${peindre("yellow", t("Hors ligne.", "Offline."))}`, ` ${peindre("dim", t("r pour réessayer", "r to retry"))}`);
      else l.push(` ${peindre("dim", t("Aucun projet.", "No project."))}`, ` ${peindre("dim", t("Créez-en un sur postship.fr", "Create one on postship.fr"))}`);
      return l;
    }
    if (affiches.length === 0) {
      l.push(` ${peindre("dim", t("Aucun projet ne correspond.", "No project matches."))}`);
      return l;
    }
    const sel = Math.max(0, affiches.findIndex((p) => p.id === e.selId));
    const place = n - 2;
    const debut = Math.min(Math.max(0, sel - Math.floor(place / 2)), Math.max(0, affiches.length - place));
    for (const [i, p] of affiches.slice(debut, debut + place).entries()) {
      const actif = debut + i === sel;
      const etatP = p.paused ? "muted" : p.status;
      const nb = d.ouverts.get(p.id)?.length ?? 0;
      const droite = p.paused ? peindre("dim", t("pause", "paused")) : nb ? peindre("red", String(nb)) : "";
      const puce = peindre(TEINTE[etatP] ?? "dim", p.paused ? (U ? "○" : "o") : U ? "●" : "*");
      const marqueur = actif && !couleursActives() ? ">" : " ";
      const nom = tronquer(p.name, lw - 6 - visible(droite).length);
      const ligne = `${completer(`${marqueur}${puce} ${actif ? peindre("bold", nom) : nom}`, lw - 1 - visible(droite).length)}${droite}`;
      // La ligne choisie est pleine quand la liste a la main, en retrait quand c'est le détail.
      l.push(actif ? (e.focus === "projets" ? surFond("choix", completer(ligne, lw)) : peindre("bold", ligne)) : ligne);
    }
    return l;
  }

  function onglets(e) {
    return VUES_UI.map((v) => (v.id === e.vue ? peindre("signal", peindre("bold", v[L])) : peindre("dim", v[L]))).join("   ");
  }

  function vueApercu(e, d, p, minScore) {
    const l = [`${peindre("bold", p.name)}  ${peindre("dim", adresseCourte(p.url))}`, ""];
    const ouverts = d.ouverts.get(p.id) ?? [];
    const det = d.details.get(p.id);
    const ship = det?.ship ?? d.ships.get(p.id) ?? null;
    const lab = (s) => peindre("dim", s.padEnd(14));

    const v = verdictLivraison({ paused: p.paused, ouverts: ouverts.length, ship, minScore });
    const textes = {
      pause: `${symbole("muted")} ${peindre("dim", t("En pause : aucune vérification.", "Paused: no checks."))}`,
      pret: `${symbole("pass")} ${peindre("green", t("Prêt à livrer", "Clear to ship"))}`,
      inconnu: `${symbole("skip")} ${peindre("dim", t("Aucun déploiement suivi : rien à juger.", "No deploy tracked: nothing to judge."))}`,
      attente: `${peindre("yellow", U ? "…" : "...")} ${peindre("yellow", t("Le dernier ship est en cours de vérification.", "The last ship is being checked."))}`,
    };
    const bloque = {
      incidents: v.n === 1 ? t("Livraison bloquée : 1 incident ouvert", "Shipping blocked: 1 open incident") : t("Livraison bloquée : {0} incidents ouverts", "Shipping blocked: {0} open incidents", v.n),
      ship: t("Livraison bloquée : le dernier ship est en échec", "Shipping blocked: the last ship failed"),
      score: t("Livraison bloquée : score {0} sous le seuil de {1}", "Shipping blocked: score {0} below the {1} threshold", v.score, v.minScore),
    };
    l.push(v.etat === "bloque" ? `${symbole("fail")} ${peindre("red", bloque[v.raison])}` : textes[v.etat]);
    for (const i of ouverts.slice(0, 4)) l.push(`   ${symbole(i.outcome)} ${adresseCourte(i.url)}  ${peindre("dim", i.kind ?? "")}  ${peindre("dim", t("constaté {0}", "seen {0}", relatif(i.since)))}`);
    if (ouverts.length > 4) l.push(peindre("dim", `   ${t("… et {0} autres — 2 pour la liste", "… and {0} more — 2 for the list", ouverts.length - 4)}`));
    l.push("");

    if (!det) l.push(peindre("dim", t("Lecture…", "Reading…")));
    else {
      l.push(`${lab(t("Dernier ship", "Last ship"))}${ship ? ligneShip(ship, "") : peindre("dim", t("aucun déploiement suivi", "no deploy tracked"))}`);
      const notes = (det.ships ?? []).filter((s) => typeof s.score === "number");
      if (notes.length > 1) l.push(`${lab(t("Historique", "History"))}${courbe([...det.ships].reverse().map((s) => s.score))}  ${peindre("dim", t("moyenne {0}", "average {0}", Math.round(notes.reduce((a, s) => a + s.score, 0) / notes.length)))}`);
      if (det.urls) {
        const actives = det.urls.filter((u) => u.enabled);
        const ko = actives.filter((u) => u.outcome === "fail" || u.outcome === "error").length;
        l.push(`${lab("URLs")}${t("{0} surveillées", "{0} monitored", actives.length)}${ko ? peindre("red", ` · ${ko} ${t("en échec", "failing")}`) : peindre("green", ` · ${t("toutes bonnes", "all good")}`)}`);
      }
      if (det.statusPage) l.push(`${lab(t("Page de statut", "Status page"))}/s/${det.statusPage}  ${peindre("dim", t("s pour l'ouvrir", "s to open it"))}`);
    }
    const evenements = e.journal.filter((x) => x.projet === p.id).slice(0, 5);
    if (evenements.length) {
      l.push("", peindre("dim", t("Pendant cette séance", "This session")));
      for (const x of evenements) l.push(`${peindre("dim", x.heure)}  ${x.texte}`);
    }
    return l;
  }

  function texteRangee(vue, r) {
    if (vue === "incidents") return `${symbole(r.incident.outcome)} ${adresseCourte(r.incident.url)}  ${peindre("dim", r.incident.kind ?? "")}  ${peindre("dim", t("constaté {0}", "seen {0}", relatif(r.incident.since)))}`;
    if (vue === "urls") return `${verdict(r.cible.enabled ? r.cible.outcome : "muted")}  ${peindre("dim", String(r.cible.kind ?? "").padEnd(12))}  ${adresseCourte(r.cible.url)}  ${peindre("dim", relatif(r.cible.lastCheckedAt))}`;
    const s = r.ship;
    return `${verdict(s.outcome)}  ${peindre("bold", String(s.sha ?? "").slice(0, 7) || "—")}  ${peindre("dim", (s.provider ?? "—").padEnd(8))}  ${relatif(s.at).padEnd(14)}  ${typeof s.score === "number" ? jauge(s.score) : peindre("dim", "—")}`;
  }

  function vueListe(e, d, p, n, rw) {
    const rangees = rangeesVue(e.vue, p, d);
    const det = d.details.get(p.id);
    const l = [];
    if (e.vue !== "incidents" && !det) return [peindre("dim", t("Lecture…", "Reading…"))];
    if (!rangees.length) {
      if (e.vue === "incidents") return [`${symbole("pass")} ${peindre("green", t("Rien d'ouvert sur {0}.", "Nothing open on {0}.", p.name))}`];
      return [peindre("dim", e.vue === "urls" ? t("Aucune URL.", "No URL.") : t("Aucun déploiement de production suivi.", "No production deploy tracked."))];
    }
    if (e.vue === "ships" && rangees.length > 1) l.push(`${courbe([...det.ships].reverse().map((s) => s.score))}  ${peindre("dim", t("{0} derniers ships", "last {0} ships", rangees.length))}`, "");
    const place = n - l.length - 1;
    const sel = e.focus === "detail" ? Math.min(e.ligne, rangees.length - 1) : -1;
    const debut = Math.min(Math.max(0, sel - Math.floor(place / 2)), Math.max(0, rangees.length - place));
    rangees.slice(debut, debut + place).forEach((r, i) => {
      const texte = tronquer(texteRangee(e.vue, r), rw);
      l.push(debut + i === sel ? surFond("choix", completer(texte, rw)) : texte);
    });
    if (e.focus !== "detail") l.push("", peindre("dim", t("Tab pour choisir une ligne", "Tab to pick a line")));
    else l.push("", peindre("dim", e.vue === "ships" ? t("o ouvre les déploiements · Échap revient", "o opens deploys · Esc goes back") : t("c vérifie cette adresse · o l'ouvre · Échap revient", "c checks this address · o opens it · Esc goes back")));
    return l;
  }

  function vueSortie(e, n) {
    if (!e.sortie.length) return [peindre("dim", t("Le résultat des commandes s'affiche ici : c vérifie le projet, / ouvre la liste des commandes.", "Command results show up here: c checks the project, / opens the command list."))];
    const fin = Math.max(0, e.sortie.length - e.defil);
    return e.sortie.slice(Math.max(0, fin - Math.max(1, n)), fin);
  }

  function panneauDetail(e, d, rw, n, minScore) {
    const l = [onglets(e), ""];
    const p = projetsAffiches(e, d).find((x) => x.id === e.selId) ?? null;
    if (e.vue === "sortie") l.push(...vueSortie(e, n - 2));
    else if (!p) l.push(peindre("dim", t("Aucun projet à afficher.", "No project to show.")));
    else if (e.vue === "apercu") l.push(...vueApercu(e, d, p, minScore));
    else l.push(...vueListe(e, d, p, n - 2, rw));
    return l.slice(0, n).map((x) => tronquer(x, rw));
  }

  function piedDePage(e, w) {
    if (e.palette) {
      const droite = peindre("dim", `${t("Entrée", "Enter")} ${t("lancer", "run")} · Tab ${t("compléter", "complete")} · ${t("Échap", "Esc")} ${t("fermer", "close")}`);
      return `${completer(tronquer(` ${peindre("signal", "/")}${e.saisie}${curseur()}`, w - visible(droite).length - 2), w - visible(droite).length - 1)}${droite}`;
    }
    if (e.action) {
      const droite = peindre("dim", t("Échap annule", "Esc cancels"));
      return `${completer(tronquer(` ${peindre("signal", ROUE[e.image % ROUE.length])} ${e.action.libelle}`, w - 16), w - visible(droite).length - 1)}${droite}`;
    }
    if (e.flash && Date.now() < e.flash.jusqua) return ` ${tronquer(e.flash.texte, w - 2)}`;
    if (e.filtreEdition) return ` ${touche(t("Entrée", "Enter"), t("garder le filtre", "keep the filter"))}   ${touche(t("Échap", "Esc"), t("l'effacer", "clear it"))}`;
    const toujours = [touche("?", t("aide", "help")), touche("q", t("quitter", "quit"))];
    const raccourcis =
      e.focus === "detail"
        ? [touche(U ? "↑↓" : "Up/Dn", t("ligne", "line")), touche("c", t("vérifier", "check")), touche("o", t("ouvrir", "open")), touche(t("Échap", "Esc"), t("revenir", "back"))]
        : [touche(U ? "↑↓" : "Up/Dn", t("projet", "project")), touche(U ? "←→" : "Left/Right", t("vue", "view")), touche("c", t("vérifier", "check")), touche("w", t("attendre le ship", "wait for the ship")), touche("f", t("filtrer", "filter")), touche("/", t("commande", "command")), touche("o", t("ouvrir", "open"))];
    const pris = [];
    for (const r of raccourcis) {
      if (visible([...pris, r, ...toujours].join("   ")).length + 2 > w) break;
      pris.push(r);
    }
    return ` ${[...pris, ...toujours].join("   ")}`;
  }

  function entete(e, d, w) {
    const gauche = ` ${peindre("signal", peindre("bold", "<>"))} ${peindre("bold", "postship")}`;
    // Du plus utile au moins utile : ce qui ne tient pas tombe par la fin.
    const infos = [];
    if (e.versionDispo) infos.push(peindre("yellow", t("{0} disponible — /update", "{0} available — /update", e.versionDispo)));
    infos.push(d.horsLigne ? peindre("yellow", t("hors ligne", "offline")) : d.majLe ? peindre("dim", t("à jour à {0}", "as of {0}", heure(d.majLe))) : peindre("dim", t("lecture…", "reading…")));
    if (d.moi) {
      const ratio = d.moi.quota.limit ? d.moi.quota.used / d.moi.quota.limit : 0;
      infos.push(peindre("dim", nomPlan(d.moi.plan)), peindre(ratio >= 0.9 ? "red" : ratio >= 0.7 ? "yellow" : "dim", `${d.moi.quota.used}/${d.moi.quota.limit} ${t("vérifications", "checks")}`));
    }
    if (e.notifications) infos.push(peindre("dim", t("notifications", "notifications")));
    const place = w - visible(gauche).length - 3;
    while (infos.length > 1 && visible(infos.join(" · ")).length > place) infos.pop();
    const droite = tronquer(infos.join(peindre("dim", " · ")), Math.max(0, place));
    return `${completer(gauche, w - visible(droite).length - 1)}${droite} `;
  }

  function ecranPrincipal(e, d, w, h, minScore) {
    const lignes = [entete(e, d, w), peindre("trait", B.h.repeat(w))];
    const corps = h - 4;
    const lw = Math.max(24, Math.min(38, Math.floor(w * 0.28)));
    const rw = w - lw - 3;
    const g = panneauProjets(e, d, lw, corps);
    const dt = panneauDetail(e, d, rw, corps, minScore);
    for (let i = 0; i < corps; i++) lignes.push(`${completer(tronquer(g[i] ?? "", lw), lw)} ${peindre("trait", B.v)} ${dt[i] ?? ""}`);
    lignes.push(peindre("trait", B.h.repeat(w)), piedDePage(e, w));

    if (e.palette && e.menu.length) {
      const place = Math.min(8, corps - 1, e.menu.length);
      const debut = Math.min(Math.max(0, e.selMenu - place + 1), Math.max(0, e.menu.length - place));
      const vus = e.menu.slice(debut, debut + place);
      const largNom = Math.min(24, Math.max(...vus.map((x) => x.nom.length)) + 2);
      vus.forEach((x, i) => {
        const actif = debut + i === e.selMenu;
        const ligne = completer(tronquer(` ${actif ? peindre("signal", U ? "›" : ">") : " "} ${peindre("bold", x.nom.padEnd(largNom))} ${peindre("dim", x.texte)}`, w), w);
        lignes[h - 2 - place + i] = actif ? surFond("choix", ligne) : ligne;
      });
    }

    if (e.aide) {
      const col = (k, v) => `${peindre("bold", k.padEnd(8))}${peindre("dim", v)}`;
      const g2 = [
        col(U ? "↑ ↓" : "Up Dn", t("choisir un projet", "choose a project")),
        col(U ? "← →" : "Lt Rt", t("changer de vue", "switch view")),
        col("Tab", t("choisir une ligne de la vue", "pick a line in the view")),
        col("f", t("filtrer les projets", "filter projects")),
        col("/", t("taper une commande", "type a command")),
        col(t("Échap", "Esc"), t("annuler, revenir", "cancel, go back")),
      ];
      const d2 = [
        col("c", t("vérifier (1 du quota)", "check (1 of quota)")),
        col("w", t("attendre le prochain ship", "wait for the next ship")),
        col("o", t("ouvrir dans le navigateur", "open in the browser")),
        col("s", t("ouvrir la page de statut", "open the status page")),
        col("d", t("projet par défaut", "default project")),
        col("n", t("notifications du bureau", "desktop notifications")),
      ];
      const bloc = [peindre("bold", t("Raccourcis", "Shortcuts")), ""];
      for (let i = 0; i < g2.length; i++) bloc.push(`${completer(g2[i], 38)}${d2[i] ?? ""}`);
      bloc.push("", peindre("dim", t("/ puis une commande : check example.com, wait --head, whoami, logout, update… · r relit · q quitte", "/ then a command: check example.com, wait --head, whoami, logout, update… · r reads again · q quits")), peindre("dim", t("Une touche ferme cette aide.", "Any key closes this help.")));
      const haut = Math.max(2, Math.floor((h - bloc.length) / 2) - 1);
      const marge = " ".repeat(Math.max(2, Math.floor((w - 80) / 2)));
      lignes[haut - 1] = peindre("trait", B.h.repeat(w));
      bloc.forEach((b, i) => (lignes[haut + i] = completer(`${marge}${tronquer(b, w - marge.length)}`, w)));
      lignes[haut + bloc.length] = peindre("trait", B.h.repeat(w));
    }
    return lignes;
  }

  /** L'image entière de l'écran, selon l'écran courant. */
  function rendre(e, d, w, h, minScore) {
    if (w < LARGEUR_MIN_UI || h < HAUTEUR_MIN_UI) {
      const lignes = new Array(h).fill("");
      lignes[Math.floor(h / 2) - 1] = ` ${peindre("bold", "postship")}`;
      lignes[Math.floor(h / 2)] = ` ${t("Agrandissez la fenêtre ({0} × {1} au moins).", "Enlarge the window ({0} × {1} at least).", LARGEUR_MIN_UI, HAUTEUR_MIN_UI)}`;
      return lignes;
    }
    const ww = w - 1;
    switch (e.ecran) {
      case "chargement":
        return centre([...etat(e, ww)], "", ww, h);
      case "connexion":
        return ecranConnexion(e, ww, h);
      case "navigateur":
        return ecranNavigateur(e, ww, h);
      case "cle":
        return ecranCle(e, ww, h);
      case "projet-defaut":
        return ecranProjetDefaut(e, d, ww, h);
      case "notifications":
        return ecranNotifications(e, ww, h);
      default:
        return ecranPrincipal(e, d, ww, h, minScore);
    }
  }

  return { rendre, heure };
}

// ---- interface.mjs
// L'interface plein écran : `postship` tapé seul dans un terminal. Une
// fenêtre à elle (l'écran alternatif, comme vim ou htop).
//
// Au premier lancement, un accueil guidé : se connecter (le navigateur de
// cet ordinateur, ou une clé d'API collée), choisir le projet par défaut,
// les notifications du bureau. Ensuite, deux panneaux : les projets à
// gauche — ceux qui ont un incident en tête, `f` pour filtrer —, le projet
// choisi à droite, en cinq vues. Tab passe au panneau de droite pour agir
// sur une ligne (vérifier ou ouvrir une adresse). Toutes les 30 s, les
// projets sont relus ; un incident qui s'ouvre ou se ferme, un ship qui
// vient d'être vérifié, passent dans la ligne du bas avec une sonnerie.
//
// Ce fichier ne fait que piloter : l'écran (ui/ecran.mjs), les données
// (ui/donnees.mjs) et le rendu (ui/vues.mjs) vivent à côté.














/** Les commandes qui quittent l'interface pour s'exécuter dans le terminal : elles y lisent le clavier, ou remplacent la CLI. */
const COMMANDES_TERMINAL_UI = new Set(["update", "uninstall", "init", "watch", "completion"]);
const COMMANDES_PROJET_UI = new Set(["status", "check", "incidents", "ship", "ships", "urls", "wait", "gate", "open"]);
const SORTIE_MAX_UI = 2000;

/**
 * Lance l'interface. `commandes` : les fonctions de la CLI (postship.mjs
 * les passe). Rend null en quittant, ou la ligne de commande à exécuter
 * ensuite dans le terminal (update, uninstall, init…).
 */
function lancerInterface(commandes, { entree = process.stdin, sortie = process.stdout, intervalle = 30_000, detecter = true } = {}) {
  const L = langue();
  const U = unicode();
  const ecran = creerEcran(sortie);
  const donnees = creerDonnees();
  const d = donnees.d;
  const vues = creerVues({ L, U });
  const config = lireConfig();
  const machine = nomMachine();
  const minScore = lireMinScore(undefined);

  const e = {
    ecran: "chargement",
    methode: 0,
    saisie: "",
    demande: null,
    occupe: null,
    message: null,
    erreur: null,
    choix: 0,
    selId: null,
    vue: "apercu",
    focus: "projets",
    ligne: 0,
    filtre: "",
    filtreEdition: false,
    sortie: [],
    defil: 0,
    journal: [],
    projetDefaut: config.projetDefaut ?? lireProjet(undefined) ?? null,
    notifications: config.notifications === true,
    palette: false,
    menu: [],
    selMenu: 0,
    histo: lireHistorique(),
    iHisto: -1,
    aide: false,
    flash: null,
    action: null,
    image: 0,
    versionDispo: null,
    fin: false,
  };
  let quitter = (suite = null) => void suite;
  let jetonConnexion = null;
  let animation = null;
  let delaiDetails = null;

  // --- les sorties des commandes, capturées dans la vue Sortie ----------

  const als = new AsyncLocalStorage();
  const muet = () => als.getStore()?.annule === true;
  const origines = { log: console.log, error: console.error, out: process.stdout.write, err: process.stderr.write, roue: process.env.POSTSHIP_NO_SPINNER };
  process.env.POSTSHIP_NO_SPINNER = "1";
  const capturer = (...a) => {
    if (muet() || e.fin) return;
    for (const l of a.join(" ").split("\n")) e.sortie.push(masquer(l));
    if (e.sortie.length > SORTIE_MAX_UI) e.sortie.splice(0, e.sortie.length - SORTIE_MAX_UI);
    dessiner();
  };
  console.log = capturer;
  console.error = capturer;
  // Une commande qui écrirait directement ne griffe pas l'écran ; seule la sonnerie passe.
  process.stdout.write = function (morceau, ...reste) {
    if (sortie !== process.stdout) return origines.out.call(process.stdout, morceau, ...reste);
    return String(morceau) === "\x07" ? origines.out.call(process.stdout, "\x07") : true;
  };
  process.stderr.write = function (morceau) {
    return String(morceau) === "\x07" ? origines.err.call(process.stderr, "\x07") : true;
  };

  // --- le dessin -----------------------------------------------------------

  let prevu = false;
  function dessiner() {
    if (e.fin || prevu) return;
    // Une seule recomposition par tour de boucle, même après dix changements.
    prevu = true;
    queueMicrotask(() => {
      prevu = false;
      if (e.fin) return;
      const { w, h } = ecran.taille();
      ecran.peindre(vues.rendre(e, d, w, h, minScore), h);
    });
  }

  function flash(texte, ms = 5000) {
    e.flash = { texte, jusqua: Date.now() + ms };
    dessiner();
    setTimeout(() => dessiner(), ms + 50).unref?.();
  }

  function occuper(texte) {
    e.occupe = texte;
    if (texte) e.erreur = null;
    clearInterval(animation);
    animation = texte
      ? setInterval(() => {
          e.image++;
          dessiner();
        }, 100)
      : null;
    dessiner();
  }

  // --- le projet choisi ------------------------------------------------------

  const affiches = () => projetsAffiches(e, d);
  const projetChoisi = () => affiches().find((p) => p.id === e.selId) ?? null;

  /** Garde un projet choisi qui existe dans la liste affichée (après un relevé, un filtre). */
  function recaler() {
    const liste = affiches();
    if (!liste.some((p) => p.id === e.selId)) e.selId = liste[0]?.id ?? null;
  }

  /** Le détail du projet choisi, lu après un court repos : parcourir la liste ne lance pas dix lectures. */
  function detailsBientot(forcer = false) {
    clearTimeout(delaiDetails);
    delaiDetails = setTimeout(() => {
      donnees.chargerDetails(projetChoisi(), forcer).then(dessiner, dessiner);
    }, 120);
    delaiDetails.unref?.();
  }

  // --- le relevé en direct ---------------------------------------------------

  async function relever(annoncer = true) {
    if (e.fin || !lireJeton()) return;
    const r = await donnees.rafraichir({ annoncer });
    if (e.fin) return;
    if (r.refuse) {
      // Clé révoquée ou expirée : retour à la connexion, avec la raison.
      donnees.oublier();
      Object.assign(e, { ecran: "connexion", methode: 0, erreur: t("Votre clé n'est plus acceptée : reconnectez ce terminal.", "Your key is no longer accepted: sign this terminal in again.") });
      return dessiner();
    }
    recaler();
    if (r.evenements.length) annoncerEvenements(r.evenements);
    dessiner();
  }

  function annoncerEvenements(evenements) {
    const h = vues.heure(Date.now());
    const textes = [];
    for (const ev of evenements) {
      let texte;
      if (ev.type === "ouvert") texte = `${symbole("fail")} ${peindre("red", t("incident ouvert", "incident opened"))}  ${adresseCourte(ev.url)}`;
      else if (ev.type === "resolu") texte = `${symbole("pass")} ${peindre("green", t("résolu", "resolved"))}  ${adresseCourte(ev.url)}`;
      else {
        const echec = ev.ship.outcome === "fail" || ev.ship.outcome === "error";
        const sha = String(ev.ship.sha ?? "").slice(0, 7) || "—";
        texte = echec
          ? `${symbole("fail")} ${peindre("red", t("ship {0} en échec", "ship {0} failed", sha))}${typeof ev.ship.score === "number" ? peindre("dim", ` · ${ev.ship.score}`) : ""}`
          : `${symbole("pass")} ${peindre("green", t("ship {0} vérifié", "ship {0} checked", sha))}${typeof ev.ship.score === "number" ? peindre("dim", ` · ${ev.ship.score}`) : ""}`;
      }
      e.journal.unshift({ projet: ev.projet.id, heure: h, texte });
      textes.push({ texte: `${texte} ${peindre("dim", `· ${ev.projet.name}`)}`, brut: `${ev.projet.name} — ${ev.type === "ship" ? `ship ${String(ev.ship.sha ?? "").slice(0, 7)} ${ev.ship.outcome}` : adresseCourte(ev.url)}` });
    }
    e.journal.splice(50);
    sonner();
    flash(textes.map((x) => x.texte).join("   "), 15_000);
    if (e.notifications) notifierBureau(t("PostShip — {0} changement(s)", "PostShip — {0} change(s)", textes.length), textes.map((x) => x.brut).join(" · "));
  }

  // --- la connexion ------------------------------------------------------

  function dormirAnnulable(jeton) {
    return (ms) =>
      new Promise((resolve, reject) => {
        const minuterie = setTimeout(resolve, ms);
        jeton.reveil = () => {
          clearTimeout(minuterie);
          reject(new ErreurCli(t("Annulé.", "Cancelled."), 2));
        };
      });
  }

  function annulerConnexion() {
    if (jetonConnexion) {
      jetonConnexion.annule = true;
      jetonConnexion.reveil?.();
    }
    jetonConnexion = null;
    occuper(null);
  }

  async function connexionNavigateur() {
    annulerConnexion();
    Object.assign(e, { ecran: "navigateur", demande: null, erreur: null, message: null });
    const jeton = { annule: false };
    jetonConnexion = jeton;
    occuper(t("Demande d'un code…", "Requesting a code…"));
    try {
      const dm = await demarrerAppareil(machine);
      if (jeton.annule) return;
      e.demande = dm;
      if (!ouvrirNavigateur(dm.lienComplet)) e.message = t("Le navigateur ne s'est pas ouvert : copiez l'adresse.", "The browser did not open: copy the address.");
      occuper(t("En attente de l'autorisation…", "Waiting for the authorization…"));
      const r = await attendreAppareil(dm, { dormir: dormirAnnulable(jeton), annule: () => jeton.annule });
      if (jeton.annule) return;
      enregistrerConnexion({ ...r, machine });
      await apresConnexion();
    } catch (err) {
      if (jeton.annule) return;
      occuper(null);
      e.erreur = err?.message ?? String(err);
      dessiner();
    }
  }

  async function apresConnexion() {
    occuper(t("Lecture de vos projets…", "Reading your projects…"));
    donnees.oublier();
    await relever(false);
    occuper(null);
    if (e.ecran === "connexion") return;
    if (!lireConfig().accueilFait) versReglages();
    else versPrincipal();
  }

  function enregistrerReglages(valeurs) {
    try {
      ecrireConfig({ ...lireConfig(), ...valeurs });
    } catch {
      flash(peindre("yellow", t("Réglage non enregistré : la configuration n'est pas inscriptible.", "Setting not saved: the configuration is not writable.")));
    }
  }

  function versReglages() {
    const liste = trierProjets(d.projets, d.ouverts);
    e.choix = Math.max(0, liste.findIndex((p) => p.id === e.projetDefaut) + 1);
    e.ecran = d.projets.length ? "projet-defaut" : "notifications";
    if (e.ecran === "notifications") e.choix = e.notifications ? 0 : 1;
    dessiner();
  }

  function versPrincipal() {
    e.ecran = "principal";
    e.focus = "projets";
    e.selId = d.projets.some((p) => p.id === e.projetDefaut) ? e.projetDefaut : null;
    recaler();
    detailsBientot();
    dessiner();
  }

  // --- les commandes -------------------------------------------------------

  async function executer(nom, args, libelle) {
    if (e.action) return flash(t("Une action est déjà en cours : Échap l'annule.", "An action is already running: Esc cancels it."));
    const fn = nom === "aide" ? commandes.help : commandes[nom];
    if (!fn) return;
    const jeton = { annule: false };
    e.action = { libelle, jeton };
    Object.assign(e, { vue: "sortie", defil: 0, focus: "projets" });
    e.sortie.push("", `${peindre("signal", U ? "›" : ">")} ${peindre("bold", masquer(libelle))}`);
    const animationAction = setInterval(() => {
      e.image++;
      dessiner();
    }, 100);
    dessiner();
    let resultat;
    try {
      resultat = await new Promise((resolve, reject) => {
        jeton.lacher = () => resolve("annule");
        als.run(jeton, () => {
          Promise.resolve()
            .then(() => fn(args, { dormir: dormirAnnulable(jeton), progression: false }))
            .then(resolve, reject);
        });
      });
      if (resultat === "annule") e.sortie.push(peindre("dim", t("Annulé.", "Cancelled.")));
    } catch (err) {
      resultat = "erreur";
      if (!jeton.annule) e.sortie.push(peindre("red", masquer(err?.message ?? String(err))));
    } finally {
      clearInterval(animationAction);
      e.action = null;
    }
    // Déconnecté seulement si la déconnexion a réussi : une clé posée dans POSTSHIP_TOKEN reste là.
    if (nom === "logout" && resultat === 0 && !lireJeton()) {
      donnees.oublier();
      Object.assign(e, { ecran: "connexion", methode: 0 });
    } else if (["check", "wait", "gate"].includes(nom)) {
      void relever(true);
      detailsBientot(true);
    }
    dessiner();
  }

  function annulerAction() {
    const j = e.action?.jeton;
    if (!j || j.annule) return;
    j.annule = true;
    j.reveil?.();
    j.lacher?.();
  }

  function lancerLigne(brut) {
    const ligne = brut.trim();
    if (!ligne) return;
    if (e.histo[e.histo.length - 1] !== ligne) e.histo.push(ligne);
    ecrireHistorique(e.histo);
    const argv = decouperLigne(ligne.replace(/^\//, ""));
    if (argv[0] === "postship") argv.shift();
    if (!argv.length) return;
    const nom = ALIAS_CONSOLE[argv[0].toLowerCase()] ?? argv[0].toLowerCase();
    const reste = argv.slice(1);
    switch (nom) {
      case "quitter":
        return quitter();
      case "aide":
        if (!reste.length) {
          e.aide = true;
          return dessiner();
        }
        return void executer("aide", parseArgs(["help", ...reste]), `help ${reste.join(" ")}`);
      case "effacer":
        e.sortie = [];
        return dessiner();
      case "projet": {
        const p = trouverProjet(d.projets, reste.join(" "));
        if (!p) return flash(peindre("yellow", t("Aucun projet ne répond à « {0} ».", "No project matches “{0}”.", reste.join(" "))));
        Object.assign(e, { filtre: "", selId: p.id, vue: "apercu", focus: "projets" });
        detailsBientot();
        return dessiner();
      }
      case "notifier": {
        const v = (reste[0] ?? "").toLowerCase();
        e.notifications = v === "off" || v === "non" || v === "no" ? false : v === "on" || v === "oui" || v === "yes" ? true : !e.notifications;
        enregistrerReglages({ notifications: e.notifications });
        return flash(e.notifications ? t("Notifications du bureau activées.", "Desktop notifications on.") : t("Notifications du bureau coupées.", "Desktop notifications off."));
      }
      case "theme": {
        const v = (reste[0] ?? "").toLowerCase();
        const choix = v === "clair" || v === "light" ? "clair" : v === "sombre" || v === "dark" ? "sombre" : null;
        enregistrerReglages({ theme: choix ?? undefined });
        definirTheme(choix ?? "neutre");
        ecran.invalider();
        return flash(choix ? t("Couleurs pour un terminal {0}.", "Colours for a {0} terminal.", choix) : t("Couleurs automatiques.", "Automatic colours."));
      }
      case "reglages":
        return versReglages();
      case "login":
        Object.assign(e, { ecran: "connexion", methode: 0, erreur: null, message: null });
        return dessiner();
      default:
        break;
    }
    if (COMMANDES_TERMINAL_UI.has(nom) || HORS_CONSOLE.has(nom)) return quitter([nom, ...reste]);
    if (!commandes[nom]) return flash(peindre("yellow", t("Commande inconnue : {0}. / pour la liste.", "Unknown command: {0}. / for the list.", argv[0])));
    const args = parseArgs([nom, ...reste]);
    if (args.token !== undefined) return flash(peindre("yellow", t("--token n'existe pas.", "--token does not exist.")));
    if (COMMANDES_PROJET_UI.has(nom) && args.project === undefined && projetChoisi()) args.project = projetChoisi().id;
    void executer(nom, args, ligne.replace(/^\//, ""));
  }

  /** L'adresse de l'app pour le projet et la vue courante. */
  function adresseApp(p, vue = e.vue) {
    const suffixe = { incidents: "/incidents", ships: "/deploys", urls: "/urls" }[vue] ?? "";
    return `${baseUrl()}/${encodeURIComponent(p.id)}${suffixe}`;
  }

  function ouvrir(url) {
    flash(ouvrirNavigateur(url) ? t("Ouvert dans le navigateur : {0}", "Opened in the browser: {0}", url) : t("Ouvrez : {0}", "Open: {0}", url), 8000);
  }

  // --- le clavier ------------------------------------------------------------

  function editer(touche) {
    if (touche.nom === "backspace") e.saisie = e.saisie.slice(0, -1);
    else if (touche.ctrl && touche.nom === "u") e.saisie = "";
    else if (touche.ctrl && touche.nom === "w") e.saisie = e.saisie.replace(/\S+\s*$/, "");
    else if (touche.texte) e.saisie += touche.texte;
    else return false;
    return true;
  }

  function toucheConnexion(touche) {
    const nom = touche.nom;
    if (e.ecran === "connexion") {
      if (nom === "up" || nom === "down" || nom === "tab") e.methode = (e.methode + 1) % METHODES_UI.length;
      else if (touche.texte === "q") return quitter();
      else if (nom === "return") {
        Object.assign(e, { erreur: null, message: null, saisie: "" });
        if (METHODES_UI[e.methode].id === "navigateur") return void connexionNavigateur();
        e.ecran = "cle";
      }
      return dessiner();
    }
    if (e.ecran === "navigateur") {
      if (nom === "escape") {
        annulerConnexion();
        e.ecran = "connexion";
      } else if (touche.texte === "q") return quitter();
      else if (nom === "return" && e.erreur) return void connexionNavigateur();
      return dessiner();
    }
    // La clé d'API.
    if (nom === "escape") Object.assign(e, { ecran: "connexion", saisie: "", erreur: null });
    else if (nom === "return" && !e.occupe) {
      const brute = e.saisie;
      occuper(t("Vérification de la clé…", "Checking the key…"));
      verifierCleApi(brute)
        .then((r) => {
          enregistrerConnexion({ token: r.token, prefix: r.prefix, machine });
          e.saisie = "";
          return apresConnexion();
        })
        .catch((err) => {
          occuper(null);
          e.erreur = err?.message ?? String(err);
          dessiner();
        });
      return;
    } else editer(touche);
    return dessiner();
  }

  function toucheReglages(touche) {
    const nom = touche.nom;
    if (e.ecran === "projet-defaut") {
      const liste = trierProjets(d.projets, d.ouverts);
      const n = liste.length + 1;
      if (nom === "up") e.choix = (e.choix + n - 1) % n;
      else if (nom === "down" || nom === "tab") e.choix = (e.choix + 1) % n;
      else if (nom === "return") {
        e.projetDefaut = e.choix === 0 ? null : liste[e.choix - 1].id;
        enregistrerReglages({ projetDefaut: e.projetDefaut ?? undefined });
        e.ecran = "notifications";
        e.choix = e.notifications || !lireConfig().accueilFait ? 0 : 1;
      }
      return dessiner();
    }
    if (nom === "up" || nom === "down" || nom === "tab") e.choix = e.choix === 0 ? 1 : 0;
    else if (nom === "return") {
      e.notifications = e.choix === 0;
      enregistrerReglages({ notifications: e.notifications, accueilFait: true });
      versPrincipal();
      return flash(t("C'est prêt. ? affiche les raccourcis.", "All set. ? shows the shortcuts."));
    }
    return dessiner();
  }

  function touchePalette(touche) {
    const nom = touche.nom;
    if (nom === "escape") e.palette = false;
    else if (nom === "return") {
      const choisi = e.menu[e.selMenu];
      const saisie = e.saisie.trim();
      // La saisie telle quelle si elle a des arguments ; sinon la commande choisie dans la liste.
      const ligne = /\s/.test(saisie) || !choisi ? saisie : choisi.argument ? null : choisi.valeur;
      if (ligne === null) {
        e.saisie = `${choisi.valeur.replace(/^\//, "")} `;
        e.menu = suggestionsConsole(e.saisie, { projets: d.projets, l: L });
        e.selMenu = 0;
        return dessiner();
      }
      Object.assign(e, { palette: false, iHisto: -1 });
      lancerLigne(ligne);
    } else if (nom === "tab" && e.menu.length) {
      e.saisie = `${e.menu[e.selMenu].valeur.replace(/^\//, "")} `;
      e.menu = suggestionsConsole(e.saisie, { projets: d.projets, l: L });
      e.selMenu = 0;
    } else if (nom === "up" || nom === "down") {
      if (e.menu.length) e.selMenu = (e.selMenu + (nom === "up" ? e.menu.length - 1 : 1)) % e.menu.length;
      else if (e.histo.length) {
        e.iHisto = nom === "up" ? (e.iHisto === -1 ? e.histo.length - 1 : Math.max(0, e.iHisto - 1)) : Math.min(e.histo.length, e.iHisto + 1);
        e.saisie = e.iHisto >= 0 && e.iHisto < e.histo.length ? e.histo[e.iHisto].replace(/^\//, "") : "";
      }
    } else if (editer(touche)) {
      e.menu = suggestionsConsole(e.saisie, { projets: d.projets, l: L });
      e.selMenu = 0;
    }
    return dessiner();
  }

  function toucheFiltre(touche) {
    if (touche.nom === "escape") Object.assign(e, { filtre: "", filtreEdition: false });
    else if (touche.nom === "return" || touche.nom === "down" || touche.nom === "up") e.filtreEdition = false;
    else {
      const avant = e.saisie;
      e.saisie = e.filtre;
      editer(touche);
      e.filtre = e.saisie.slice(0, 40);
      e.saisie = avant;
    }
    recaler();
    detailsBientot();
    return dessiner();
  }

  /** Le panneau de droite a la main (Tab) : une ligne d'incident, d'URL ou de déploiement. */
  function toucheDetail(touche) {
    const p = projetChoisi();
    const rangees = rangeesVue(e.vue, p, d);
    const cle = touche.texte ?? touche.nom;
    if (!p || !rangees.length || cle === "escape" || cle === "tab" || cle === "shift-tab") {
      e.focus = "projets";
      return dessiner();
    }
    e.ligne = Math.min(e.ligne, rangees.length - 1);
    const r = rangees[e.ligne];
    switch (cle) {
      case "up":
      case "k":
        e.ligne = (e.ligne + rangees.length - 1) % rangees.length;
        break;
      case "down":
      case "j":
        e.ligne = (e.ligne + 1) % rangees.length;
        break;
      case "c":
        if (r.url) return void executer("check", { _: ["check"], url: r.url }, t("check {0}", "check {0}", adresseCourte(r.url)));
        return flash(t("Rien à vérifier sur cette ligne.", "Nothing to check on this line."));
      case "o":
      case "return":
        ouvrir(r.url ?? adresseApp(p, "ships"));
        break;
      case "q":
        return quitter();
      default:
        return;
    }
    dessiner();
  }

  function touchePrincipal(touche) {
    const cle = touche.texte ?? touche.nom;
    const vue = VUES_UI.findIndex((v) => v.id === e.vue);
    const bouger = (delta) => {
      const liste = affiches();
      if (!liste.length) return;
      const i = Math.max(0, liste.findIndex((p) => p.id === e.selId));
      e.selId = liste[(i + delta + liste.length) % liste.length].id;
      detailsBientot();
    };
    switch (cle) {
      case "escape":
        if (e.action) return annulerAction();
        if (e.filtre) Object.assign(e, { filtre: "" });
        e.flash = null;
        break;
      case "up":
      case "k":
        bouger(-1);
        break;
      case "down":
      case "j":
        bouger(1);
        break;
      case "left":
      case "h":
        e.vue = VUES_UI[(vue + VUES_UI.length - 1) % VUES_UI.length].id;
        break;
      case "right":
      case "l":
        e.vue = VUES_UI[(vue + 1) % VUES_UI.length].id;
        break;
      case "tab":
      case "shift-tab":
        if (rangeesVue(e.vue, projetChoisi(), d).length) Object.assign(e, { focus: "detail", ligne: 0 });
        else flash(t("Rien à choisir dans cette vue : ← → pour Incidents, Déploiements ou URLs.", "Nothing to pick in this view: ← → for Incidents, Deploys or URLs."), 3000);
        break;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
        e.vue = VUES_UI[Number(cle) - 1].id;
        break;
      case "return":
        e.vue = "apercu";
        break;
      case "pageup":
        e.defil = Math.min(Math.max(0, e.sortie.length - 3), e.defil + Math.max(1, ecran.taille().h - 10));
        break;
      case "pagedown":
        e.defil = Math.max(0, e.defil - Math.max(1, ecran.taille().h - 10));
        break;
      case "c": {
        const p = projetChoisi();
        if (p) void executer("check", { _: ["check"], project: p.id }, t("check {0}", "check {0}", adresseCourte(p.url)));
        break;
      }
      case "w": {
        const p = projetChoisi();
        if (p) void executer("wait", { _: ["wait"], project: p.id }, t("wait — le prochain ship de {0}", "wait — the next ship of {0}", p.name));
        break;
      }
      case "o": {
        const p = projetChoisi();
        if (p) ouvrir(adresseApp(p));
        break;
      }
      case "s": {
        const page = projetChoisi() && d.details.get(projetChoisi().id)?.statusPage;
        if (page) ouvrir(`${baseUrl()}/s/${encodeURIComponent(page)}`);
        else flash(t("Pas de page de statut publique pour ce projet.", "No public status page for this project."), 3000);
        break;
      }
      case "f":
        Object.assign(e, { filtreEdition: true, focus: "projets" });
        break;
      case "r":
        flash(t("Relecture…", "Refreshing…"), 1500);
        void relever(true);
        detailsBientot(true);
        break;
      case "d": {
        const p = projetChoisi();
        if (p) {
          e.projetDefaut = p.id;
          enregistrerReglages({ projetDefaut: p.id });
          flash(t("{0} s'ouvrira en premier.", "{0} will open first.", p.name));
        }
        break;
      }
      case "n":
        return lancerLigne("notifier");
      case "/":
        Object.assign(e, { palette: true, saisie: "", selMenu: 0, iHisto: -1 });
        e.menu = suggestionsConsole("", { projets: d.projets, l: L });
        break;
      case "?":
        e.aide = true;
        break;
      case "q":
        return quitter();
      default:
        return;
    }
    dessiner();
  }

  function surTouche(touche) {
    // Ctrl+C : annule ce qui tourne, sinon quitte.
    if (touche.ctrl && touche.nom === "c") return e.action ? annulerAction() : quitter();
    if (e.ecran === "connexion" || e.ecran === "navigateur" || e.ecran === "cle") return toucheConnexion(touche);
    if (e.ecran === "projet-defaut" || e.ecran === "notifications") return toucheReglages(touche);
    if (e.ecran !== "principal") return;
    // Un morceau collé (« /update --check ») se lit lettre par lettre :
    // « / » ouvre la palette, la suite s'y écrit.
    if (!e.palette && !e.filtreEdition && touche.texte && touche.texte.length > 1) {
      for (const c of touche.texte) surTouche({ texte: c });
      return;
    }
    if (e.aide) {
      e.aide = false;
      return dessiner();
    }
    if (e.palette) return touchePalette(touche);
    if (e.filtreEdition) return toucheFiltre(touche);
    if (e.focus === "detail") return toucheDetail(touche);
    return touchePrincipal(touche);
  }

  // --- l'entrée et la sortie ---------------------------------------------

  return new Promise((resoudre) => {
    let minuterie = null;
    const surDonnees = (morceau) => {
      // Une réponse tardive à la question du fond (OSC 11) n'est pas une frappe.
      if (String(morceau).includes("]11;")) return;
      for (const touche of lireTouches(morceau)) {
        if (e.fin) return;
        surTouche(touche);
      }
    };
    const surRedimension = () => {
      ecran.invalider();
      dessiner();
    };
    const restaurer = () => ecran.sortir();

    quitter = (suite = null) => {
      if (e.fin) return;
      e.fin = true;
      clearInterval(minuterie);
      clearInterval(animation);
      clearTimeout(delaiDetails);
      annulerConnexion();
      annulerAction();
      entree.off("data", surDonnees);
      sortie.off?.("resize", surRedimension);
      process.off("exit", restaurer);
      restaurer();
      entree.setRawMode?.(false);
      entree.pause();
      console.log = origines.log;
      console.error = origines.error;
      process.stdout.write = origines.out;
      process.stderr.write = origines.err;
      if (origines.roue === undefined) delete process.env.POSTSHIP_NO_SPINNER;
      else process.env.POSTSHIP_NO_SPINNER = origines.roue;
      resoudre(suite);
    };

    (async () => {
      entree.setRawMode?.(true);
      entree.resume();
      const impose = process.env.POSTSHIP_THEME || config.theme;
      if (impose === "clair" || impose === "sombre") definirTheme(impose);
      else definirTheme((detecter ? await detecterTheme(entree, ecran.ecrire) : null) ?? "neutre");
      process.on("exit", restaurer);
      ecran.entrer();
      entree.on("data", surDonnees);
      sortie.on?.("resize", surRedimension);
      if (!VERSION.startsWith("__")) {
        versionPubliee()
          .then((v) => {
            if (v && plusRecente(VERSION, v)) {
              e.versionDispo = v;
              dessiner();
            }
          })
          .catch(() => undefined);
      }
      if (!lireJeton()) {
        e.ecran = "connexion";
        dessiner();
      } else {
        occuper(t("Lecture de vos projets…", "Reading your projects…"));
        await relever(false);
        occuper(null);
        if (e.ecran !== "connexion") {
          if (!config.accueilFait) versReglages();
          else versPrincipal();
        }
      }
      minuterie = setInterval(() => void relever(true), intervalle);
      minuterie.unref?.();
    })().catch((err) => {
      quitter(null);
      origines.error(masquer(err?.message ?? String(err)));
    });
  });
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
  ecrire(`  ${symbole(payload.outcome)} ${peindre("bold", adresseCourte(payload.url))}   ${verdict(payload.outcome).trim()}   ${jauge(payload.score)}${payload.reason ? peindre("dim", `   ${payload.reason}`) : ""}`);
  const largeur = Math.max(0, ...(payload.checks ?? []).map((c) => String(c.label).length));
  for (const item of payload.checks ?? []) {
    ecrire(`    ${symbole(item.outcome)} ${String(item.label).padEnd(largeur)}  ${peindre("dim", item.detail ?? "")}`);
  }
  if (payload.quota) ecrire(peindre("dim", `  ${jaugeQuota(payload.quota.used, payload.quota.limit)} ${t("vérifications ce mois-ci", "checks this month")}`));
  ecrire();
}

/** « exemple.fr » tapé seul devient « https://exemple.fr » : l'API ne vérifie que du https. */
function urlSaisie(brut) {
  const s = String(brut).trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

async function check(args) {
  // `postship check exemple.fr` : l'adresse en argument, sans --url.
  let urls = [...toutes(args.url), ...(args._ ?? []).slice(1).map(urlSaisie)];
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
    const attente = json || quiet ? null : roue(t("Vérification de {0}… (jusqu'à une minute)", "Checking {0}… (up to a minute)", adresseCourte(url)));
    try {
      resultats.push(await appelAuthentifie("POST", "/api/v1/check", { corps: { url }, timeoutMs: 60_000 }));
    } finally {
      attente?.fin();
    }
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
  tableau(liste.map((p) => [verdict(p.paused ? "muted" : p.status), peindre("dim", courtId(p.id)), peindre("bold", p.name), adresseCourte(p.url), peindre("dim", relatif(p.lastCheckedAt))]));
  const rouges = liste.filter((p) => p.status === "fail" || p.status === "error").length;
  return args["fail-if-red"] === true && rouges > 0 ? 1 : 0;
}

// ---- commands/incidents.mjs
// `postship incidents` — GET /api/v1/projects/:id/incidents : ce qui est en panne.



/**
 * Les incidents ouverts, une ligne chacun : « × boutique.fr/panier  http
 * constaté il y a 3 min ». `since` est l'heure de la dernière vérification
 * en échec, pas le début de la panne : on écrit « constaté », pas « depuis ».
 */
function lignesIncidents(liste, retrait = "") {
  tableau(liste.map((i) => [`${retrait}${symbole(i.outcome)} ${adresseCourte(i.url)}`, peindre("dim", i.kind ?? ""), peindre("dim", t("constaté {0}", "seen {0}", relatif(i.since)))]));
}

async function incidents(args) {
  const id = projetRequis(args);
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/incidents`);
  if (sortieJson(args, payload)) return args["fail-if-open"] === true && (payload?.incidents ?? []).length > 0 ? 1 : 0;
  const liste = payload?.incidents ?? [];
  if (liste.length === 0) ecrire(`${symbole("pass")} ${t("Rien d'ouvert.", "Nothing open.")}`);
  else lignesIncidents(liste);
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
    ecrire(ligneShip(dernier, ""));
    if (dernier.scoreReason) ecrire(peindre("dim", `  ${dernier.scoreReason}`));
  }
  if (!dernier) return args.require === true ? 2 : 0;
  return codeDuShip(dernier, lireMinScore(une(args["min-score"])));
}

// ---- commands/ships.mjs
// `postship ships` — GET /api/v1/projects/:id/ships : l'historique de production, pour l'humain.
// En tête (28 sept. 2026), la courbe des scores du plus ancien au plus
// récent : on voit d'un coup d'œil si la production se dégrade.




async function ships(args) {
  const id = projetRequis(args);
  const limite = une(args.limit);
  const q = typeof limite === "string" ? `?limit=${encodeURIComponent(limite)}` : "";
  const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/ships${q}`);
  if (sortieJson(args, payload)) return 0;
  const liste = payload?.ships ?? [];
  if (liste.length === 0) {
    ecrire(t("Aucun déploiement de production suivi.", "No production deployment tracked."));
    return 0;
  }
  const scores = liste.map((s) => s.score).filter((s) => typeof s === "number");
  if (scores.length > 1) {
    const moyenne = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    ecrire(`${courbe([...liste].reverse().map((s) => s.score))}  ${peindre("dim", t("{0} ships · score moyen {1}", "{0} ships · average score {1}", liste.length, moyenne))}`);
    ecrire();
  }
  tableau(
    liste.map((s) => [
      verdict(s.outcome),
      peindre("bold", String(s.sha ?? "").slice(0, 7) || "—"),
      s.provider ?? "—",
      relatif(s.at),
      s.score === null || s.score === undefined ? peindre("dim", "—") : jauge(s.score),
      peindre("dim", s.scoreReason ?? ""),
    ]),
  );
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
  ecrire(`${peindre("bold", p.name)}  ${peindre("dim", adresseCourte(p.url))}  ${p.paused ? peindre("dim", t("en pause", "paused")) : verdict(p.status).trim()}${p.statusPage ? peindre("dim", `  ${t("statut", "status")}: /s/${p.statusPage}`) : ""}`);
  const liste = p.urls ?? [];
  if (liste.length === 0) ecrire(t("Aucune URL.", "No URL."));
  else tableau(liste.map((u) => [`  ${verdict(u.enabled ? u.outcome : "muted")}`, peindre("dim", u.kind ?? ""), adresseCourte(u.url), peindre("dim", relatif(u.lastCheckedAt))]));
  return 0;
}

// ---- commands/wait.mjs
// `postship wait` — attendre que le dernier ship de production soit
// conclu (verdict et score posés), ou qu'il porte le sha qu'on attend.
// Lecture seulement : on n'appelle jamais /check en boucle.
//
// Au quotidien (28 sept. 2026) : `git push && postship wait --head`
// attend le commit qu'on vient de pousser, une roue tourne pendant ce
// temps, le terminal sonne à la fin, et --notify prévient le bureau.






const POLL_MS = 15_000;

/** Le ship est-il conclu ? Un verdict posé et, si le score existe, un score. */
function conclu(ship, sha) {
  if (!ship) return false;
  if (sha && !String(ship.sha ?? "").startsWith(sha)) return false;
  return ship.outcome !== null && ship.outcome !== undefined && ship.outcome !== "pending" && ship.outcome !== "running";
}

/** Lance git sans shell et rend sa sortie (remplaçable dans les tests). */
function executerGit(/** @type {string} */ cmd, /** @type {string[]} */ liste) {
  return execFileSync(cmd, liste, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

/** Le commit courant du dépôt — `git rev-parse HEAD` —, ou une erreur qui dit pourquoi. */
function shaDeHead(executer = executerGit) {
  let sha = "";
  try {
    sha = String(executer("git", ["rev-parse", "HEAD"])).trim();
  } catch {
    // pas de git, ou pas un dépôt : l'erreur ci-dessous le dit
  }
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.toLowerCase();
  throw new ErreurCli(t("--head : pas de dépôt git ici (git rev-parse HEAD a échoué).", "--head: no git repository here (git rev-parse HEAD failed)."), 2);
}

async function wait(args, options = {}) {
  // `progression: false` : l'interface plein écran montre sa propre roue ; pas une ligne par relevé.
  const { dormir = (ms) => new Promise((r) => setTimeout(r, ms)), maintenant = () => Date.now(), executer = executerGit, progression = true } = /** @type {{ dormir?: (ms: number) => Promise<unknown>, maintenant?: () => number, executer?: (cmd: string, liste: string[]) => string, progression?: boolean }} */ (options);
  const id = lireProjet(une(args.project));
  if (!id) throw new ErreurCli(t("--project manquant.", "--project missing."), 2);
  const timeoutS = entier(args.timeout) ?? 600;
  if (Number.isNaN(timeoutS) || timeoutS <= 0) throw new ErreurCli(t("--timeout attend un nombre de secondes.", "--timeout expects a number of seconds."), 2);
  const shaDemande = typeof une(args.sha) === "string" ? une(args.sha) : null;
  const sha = args.head === true || shaDemande?.toUpperCase() === "HEAD" ? shaDeHead(executer) : shaDemande;
  const minScore = lireMinScore(une(args["min-score"]));
  const debut = maintenant();
  const json = args.json === true;
  const cible = sha ? t("Ship de {0}", "Ship of {0}", sha.slice(0, 7)) : t("Dernier ship", "Last ship");
  const attente = json ? null : roue(t("{0} : en attente…", "{0}: waiting…", cible));

  try {
    for (;;) {
      const payload = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(id)}/last-ship`);
      const ship = lireShip(payload);
      if (conclu(ship, sha)) {
        attente?.fin();
        if (json) console.log(JSON.stringify(payload, null, 2));
        else ecrire(ligneShip(ship));
        const code = codeDuShip(ship, minScore);
        if (!json) {
          if (minScore !== null && typeof ship.score === "number" && ship.score < minScore) ecrire(peindre("yellow", t("Ship Score {0} sous le seuil demandé ({1}).", "Ship Score {0} below the requested threshold ({1}).", ship.score, minScore)));
          sonner();
          if (args.notify === true) {
            notifierBureau(
              t("PostShip — {0} conclu", "PostShip — {0} concluded", cible.toLowerCase()),
              `${ship.outcome}${typeof ship.score === "number" ? ` · ${t("score", "score")} ${ship.score}` : ""}`,
            );
          }
        }
        return code;
      }
      const ecoule = maintenant() - debut;
      if (ecoule >= timeoutS * 1000) {
        attente?.fin();
        throw new ErreurCli(t("Délai écoulé ({0} s) : aucun ship conclu{1}.", "Timed out ({0} s): no concluded ship{1}.", timeoutS, sha ? ` ${t("pour", "for")} ${sha.slice(0, 7)}` : ""), 2);
      }
      const etape = ship && (!sha || String(ship.sha ?? "").startsWith(sha)) ? t("vérification en cours", "check running") : t("en attente du déploiement", "waiting for the deploy");
      if (attente?.actif) attente.maj(`${cible} : ${etape} · ${duree(ecoule)} ${peindre("dim", t("(Ctrl+C pour arrêter)", "(Ctrl+C to stop)"))}`);
      else if (!json && progression) ecrire(peindre("dim", `  ${symbole("skip")} ${t("en attente du ship…", "waiting for the ship…")}`));
      await dormir(POLL_MS);
    }
  } finally {
    attente?.fin();
  }
}

// ---- commands/watch.mjs
// `postship watch` — les incidents ouverts, en direct, sur un terminal
// seulement. Interdit en CI : une watch dans un workflow tourne pour rien.
//
// Depuis le 28 sept. 2026 : sans projet, tous les projets à la fois ; un
// « ding » quand un incident s'ouvre ou se ferme, et --notify pour une
// notification du bureau ; le fil des changements de la séance sous le
// tableau. De quoi la laisser ouverte dans un onglet toute la journée.





const INTERVALLE_MS = 30_000;
const INTERVALLE_MIN_S = 15;
const PROJETS_SUIVIS = 20;
const FIL_MAX = 8;

function cleIncident(i) {
  return `${i.projet ?? ""}|${i.url}|${i.kind ?? ""}`;
}

/** Ce qui a changé entre deux relevés : les incidents apparus, ceux qui ont disparu. */
function difference(avant, apres) {
  const a = new Set(avant.map(cleIncident));
  const b = new Set(apres.map(cleIncident));
  return { ouverts: apres.filter((i) => !a.has(cleIncident(i))), fermes: avant.filter((i) => !b.has(cleIncident(i))) };
}

/** Un relevé : les incidents du projet, ou ceux de tous les projets actifs (vingt au plus). */
async function releve(projetId) {
  if (projetId) {
    const p = await appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(projetId)}/incidents`);
    return { multi: false, incidents: (p?.incidents ?? []).map((i) => ({ ...i, projet: null })) };
  }
  const liste = await appelAuthentifie("GET", "/api/v1/projects");
  const projets = (liste?.projects ?? []).filter((p) => !p.paused).slice(0, PROJETS_SUIVIS);
  const lus = await Promise.all(projets.map((p) => appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(p.id)}/incidents`).catch(() => null)));
  return { multi: true, incidents: projets.flatMap((p, i) => (lus[i]?.incidents ?? []).map((x) => ({ ...x, projet: p.name }))) };
}

async function watch(args, options = {}) {
  // `dormir` et `tours` : pour les tests seulement.
  const { dormir, tours = Infinity } = /** @type {{ dormir?: (ms: number) => Promise<void>, tours?: number }} */ (options);
  if (process.env.CI === "true") throw new ErreurCli(t("watch ne tourne pas en CI : utilisez incidents --fail-if-open.", "watch does not run in CI: use incidents --fail-if-open."), 2);
  if (!process.stdout.isTTY && tours === Infinity) throw new ErreurCli(t("watch demande un terminal.", "watch needs a terminal."), 2);
  const secondes = entier(args.interval);
  if (Number.isNaN(secondes)) throw new ErreurCli(t("--interval attend un nombre de secondes.", "--interval expects a number of seconds."), 2);
  const pas = secondes === null ? INTERVALLE_MS : Math.max(INTERVALLE_MIN_S, secondes) * 1000;
  const projetId = lireProjet(une(args.project));
  const notifier = args.notify === true;

  // Ctrl+C réveille l'attente en cours : on quitte tout de suite, pas
  // au bout des trente secondes.
  let arret = false;
  let reveiller = () => {};
  const attendre =
    dormir ??
    ((ms) =>
      new Promise((r) => {
        const minuterie = setTimeout(r, ms);
        reveiller = () => {
          clearTimeout(minuterie);
          r();
        };
      }));
  const surCtrlC = () => {
    arret = true;
    reveiller();
  };
  process.once("SIGINT", surCtrlC);
  let precedent = null;
  const fil = [];
  try {
    for (let n = 0; n < tours && !arret; n++) {
      let r;
      try {
        r = await releve(projetId);
      } catch (e) {
        // Au premier tour, l'erreur est la réponse (clé, projet) ; ensuite,
        // une coupure réseau ne doit pas fermer l'écran qu'on surveille.
        if (n === 0) throw e;
        fil.unshift(`${new Date().toLocaleTimeString()}  ${peindre("yellow", t("relevé manqué", "missed read"))}  ${peindre("dim", e?.message ?? "")}`);
        r = null;
      }
      if (r) {
        if (precedent) {
          const { ouverts, fermes } = difference(precedent, r.incidents);
          const heure = new Date().toLocaleTimeString();
          const ou = (i) => `${adresseCourte(i.url)}${i.projet ? peindre("dim", ` · ${i.projet}`) : ""}`;
          for (const i of ouverts) fil.unshift(`${heure}  ${symbole("fail")} ${t("ouvert", "opened")}  ${ou(i)}`);
          for (const i of fermes) fil.unshift(`${heure}  ${symbole("pass")} ${t("résolu", "resolved")}  ${ou(i)}`);
          if (ouverts.length + fermes.length > 0) {
            sonner();
            if (notifier) {
              const titre = ouverts.length > 0 ? t("PostShip — incident ouvert", "PostShip — incident opened") : t("PostShip — incident résolu", "PostShip — incident resolved");
              notifierBureau(titre, [...ouverts, ...fermes].map((i) => adresseCourte(i.url)).join(", "));
            }
          }
        }
        precedent = r.incidents;
      }
      fil.splice(FIL_MAX);

      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      ecrire();
      ecrire(`  ${marque(peindre("dim", t("en direct · toutes les {0} s · Ctrl+C pour quitter", "live · every {0} s · Ctrl+C to quit", Math.round(pas / 1000))))}`);
      ecrire();
      const liste = precedent ?? [];
      if (liste.length === 0) {
        ecrire(`  ${symbole("pass")} ${t("Rien d'ouvert.", "Nothing open.")}`);
      } else if (!projetId) {
        const parProjet = new Map();
        for (const i of liste) parProjet.set(i.projet, [...(parProjet.get(i.projet) ?? []), i]);
        for (const [nom, lignes] of parProjet) {
          ecrire(`  ${peindre("bold", nom)}`);
          lignesIncidents(lignes, "    ");
        }
      } else {
        lignesIncidents(liste, "  ");
      }
      ecrire();
      if (fil.length > 0) {
        for (const l of fil) ecrire(`  ${l}`);
        ecrire();
      }
      ecrire(peindre("dim", `  ${t("relevé à {0}", "read at {0}", new Date().toLocaleTimeString())}${notifier ? "" : t(" · --notify pour une notification du bureau", " · --notify for a desktop notification")}`));
      if (n + 1 < tours && !arret) await attendre(pas);
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
  ecrire(
    [
      `${t("plan", "plan")} ${peindre("bold", nomPlan(payload.plan))}`,
      `${jaugeQuota(payload.quota.used, payload.quota.limit)} ${peindre("dim", t("{0} restantes ce mois", "{0} left this month", payload.quota.remaining))}`,
      `${t("clé", "key")} ${payload.token.prefix}…${payload.token.name ? peindre("dim", ` ${payload.token.name}`) : ""}${payload.token.lastUsedAt ? peindre("dim", ` · ${t("utilisée {0}", "used {0}", relatif(payload.token.lastUsedAt))}`) : ""}`,
    ].join(peindre("dim", "  ·  ")),
  );
  return 0;
}

// ---- commands/doctor.mjs
// `postship doctor` — de quoi diagnostiquer sans consommer de quota :
// Node, TLS, PostShip joignable, et le jeton accepté s'il y en a un.
// N'appelle jamais /check.


async function doctor() {
  let code = 0;
  const ligne = (ok, texte) => ecrire(`  ${symbole(ok ? "pass" : "fail")} ${texte}`);
  ecrire(`  ${marque("doctor")}`);
  ecrire();

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
    ligne(true, t("aucune clé : postship login (ou POSTSHIP_TOKEN)", "no key: postship login (or POSTSHIP_TOKEN)"));
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
// seuil, jamais la clé). Dans un terminal, la liste des projets se
// parcourt aux flèches ; sinon --project.





const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un choix au clavier : flèches haut/bas (ou j/k), Entrée pour valider,
 * Échap ou Ctrl+C pour renoncer. Sans dépendance : le mode brut de
 * stdin, et le curseur redessiné à chaque touche.
 */
function choisir(lignes, { entree = process.stdin, sortie = process.stdout } = {}) {
  return new Promise((resolve) => {
    let index = 0;
    const dessiner = (premier) => {
      if (!premier) sortie.write(`[${lignes.length}A`);
      for (const [i, l] of lignes.entries()) sortie.write(`[2K${i === index ? peindre("bold", "› ") : "  "}${l}\n`);
    };
    const finir = (valeur) => {
      entree.setRawMode?.(false);
      entree.pause();
      entree.off("data", surTouche);
      resolve(valeur);
    };
    const surTouche = (buf) => {
      const s = buf.toString();
      if (s === "" || s === "") return finir(null);
      if (s === "\r" || s === "\n") return finir(index);
      if (s === "[A" || s === "k") index = (index - 1 + lignes.length) % lignes.length;
      else if (s === "[B" || s === "j") index = (index + 1) % lignes.length;
      else return;
      dessiner(false);
    };
    entree.setRawMode?.(true);
    entree.resume();
    entree.on("data", surTouche);
    dessiner(true);
  });
}

async function init(args, io = {}) {
  let projet = typeof une(args.project) === "string" ? une(args.project) : "";
  if (!projet) {
    const interactif = io.entree ? true : process.stdin.isTTY && process.stdout.isTTY;
    if (!interactif) throw new ErreurCli(t("Passez --project <uuid> hors d'un terminal.", "Pass --project <uuid> outside a terminal."), 2);
    const payload = await appelAuthentifie("GET", "/api/v1/projects");
    const projets = payload?.projects ?? [];
    if (projets.length === 0) throw new ErreurCli(t("Aucun projet sur ce compte : créez-en un sur postship.fr.", "No project on this account: create one on postship.fr."), 2);
    ecrire(t("Quel projet ? (flèches, Entrée)", "Which project? (arrows, Enter)"));
    const i = await choisir(
      projets.map((p) => `${courtId(p.id)}  ${p.name}  ${peindre("dim", p.url)}  ${verdict(p.paused ? "muted" : p.status).trim()}`),
      io,
    );
    if (i === null) throw new ErreurCli(t("Annulé.", "Cancelled."), 2);
    projet = projets[i].id;
  }
  if (!UUID.test(projet)) throw new ErreurCli(t("Ce n'est pas un UUID de projet.", "Not a project UUID."), 2);

  const minScore = entier(args["min-score"]);
  if (Number.isNaN(minScore)) throw new ErreurCli(t("--min-score attend un nombre.", "--min-score expects a number."), 2);
  if (args.token !== undefined) throw new ErreurCli(t("Le jeton ne passe pas en argument : postship login.", "The token never goes on the command line: postship login."), 2);

  const fichier = join(process.cwd(), ".postship.json");
  writeFileSync(fichier, JSON.stringify({ project: projet, minScore: minScore ?? 80 }, null, 2) + "\n");
  ecrire(`${peindre("green", "ok")}  ${fichier}`);
  ecrire(peindre("dim", `  ${t("Commitable. La clé, elle, vient de postship login (ou de POSTSHIP_TOKEN), jamais de ce fichier.", "Committable. The key comes from postship login (or POSTSHIP_TOKEN), never from this file.")}`));
  return 0;
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
  const code = ouverts.length > 0 ? 1 : !ship ? 2 : codeDuShip(ship, minScore);
  if (args.json === true) {
    console.log(JSON.stringify({ incidents: ouverts, lastShip: ship }, null, 2));
  } else {
    ecrire(ouverts.length === 0 ? `${symbole("pass")} ${t("Rien d'ouvert.", "Nothing open.")}` : `${symbole("fail")} ${t("{0} incident(s) ouvert(s).", "{0} open incident(s).", ouverts.length)}`);
    if (!ship) ecrire(`${symbole("skip")} ${t("Aucun déploiement de production suivi.", "No production deployment tracked.")}`);
    else ecrire(ligneShip(ship));
    const conclusion = { 0: ["green", t("Barrière ouverte : la production est saine.", "Gate open: production is healthy.")], 1: ["red", t("Barrière fermée.", "Gate closed.")], 2: ["yellow", t("Impossible de se prononcer.", "Cannot tell.")] }[code];
    ecrire(peindre(conclusion[0], conclusion[1]));
  }
  return code;
}

// ---- commands/status.mjs
// `postship status` — le tableau de bord en un écran : qui parle, chaque
// projet avec ses incidents ouverts, et pour le projet courant le détail
// des pannes et le dernier ship. C'est aussi ce qu'affiche `postship`
// tout seul dans un terminal (28 sept. 2026). `postship open` — le projet
// dans le navigateur.








/** Au-delà, le tableau montre les projets sans compter leurs incidents : une lecture par projet suffit. */
const PROJETS_COMPTES = 20;

/** L'état d'un projet en un point de couleur : vert, rouge, ou éteint. */
function point(etat) {
  return peindre(TEINTE[etat] ?? "dim", unicode() ? "●" : "*");
}

/** « 2 incidents ouverts », « rien d'ouvert », ou rien quand on ne l'a pas lu. */
function resumeIncidents(n) {
  if (n === null || n === undefined) return "";
  if (n === 0) return peindre("dim", t("rien d'ouvert", "nothing open"));
  return peindre("red", n === 1 ? t("1 incident ouvert", "1 open incident") : t("{0} incidents ouverts", "{0} open incidents", n));
}

async function status(args) {
  const [moi, liste] = await Promise.all([appelAuthentifie("GET", "/api/v1/me"), appelAuthentifie("GET", "/api/v1/projects")]);
  const projets = liste?.projects ?? [];
  const courant = lireProjet(une(args.project));
  const projet = courant ? projets.find((p) => p.id === courant || String(p.id).startsWith(courant)) : null;

  // Une lecture d'incidents par projet (gratuite, en parallèle) ; celle
  // du projet courant fait foi pour le code de sortie, les autres ne font
  // qu'informer et se taisent en cas d'échec.
  const comptes = projets.slice(0, PROJETS_COMPTES);
  if (projet && !comptes.includes(projet)) comptes.push(projet);
  const lire = (p) => appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(p.id)}/incidents`);
  const [lus, dernier] = await Promise.all([
    Promise.all(comptes.map((p) => (p === projet ? lire(p) : p.paused ? Promise.resolve(null) : lire(p).catch(() => null)))),
    projet ? appelAuthentifie("GET", `/api/v1/projects/${encodeURIComponent(projet.id)}/last-ship`) : Promise.resolve(null),
  ]);
  const ouvertsPar = new Map(comptes.map((p, i) => [p.id, lus[i] ? (lus[i].incidents ?? []) : null]));
  const ouverts = projet ? (ouvertsPar.get(projet.id) ?? []) : [];
  const ship = lireShip(dernier);

  if (args.json === true) {
    const avecComptes = projets.map((p) => ({ ...p, openIncidents: ouvertsPar.get(p.id)?.length ?? null }));
    console.log(JSON.stringify({ me: moi, projects: avecComptes, project: projet ?? null, incidents: ouverts, lastShip: ship }, null, 2));
  } else {
    const origine = origineJeton() === "env" ? "(POSTSHIP_TOKEN)" : "(~/.config/postship)";
    ecrire();
    ecrire(`  ${marque(peindre("dim", adresseCourte(baseUrl())))}`);
    ecrire(`  ${[`${t("plan", "plan")} ${peindre("bold", nomPlan(moi.plan))}`, `${jaugeQuota(moi.quota.used, moi.quota.limit)} ${peindre("dim", t("vérifications ce mois", "checks this month"))}`, `${t("clé", "key")} ${moi.token?.prefix ?? "?"}… ${peindre("dim", origine)}`].join(peindre("dim", "  ·  "))}`);
    ecrire();
    if (projets.length === 0) {
      ecrire(`  ${t("Aucun projet.", "No project.")} ${peindre("dim", t("Créez le premier sur postship.fr — postship open.", "Create the first one on postship.fr — postship open."))}`);
    } else {
      tableau(
        projets.map((p) => {
          const etat = p.paused ? "muted" : p.status;
          const n = ouvertsPar.has(p.id) ? ouvertsPar.get(p.id)?.length ?? null : null;
          const nom = p === projet ? peindre("bold", p.name) : p.name;
          return [`  ${point(etat)} ${nom}`, peindre("dim", adresseCourte(p.url)), verdict(etat), p.paused ? peindre("dim", t("en pause", "paused")) : resumeIncidents(n), peindre("dim", relatif(p.lastCheckedAt))];
        }),
      );
      if (projets.length > PROJETS_COMPTES) ecrire(peindre("dim", `  ${t("Incidents comptés sur les {0} premiers projets.", "Incidents counted on the first {0} projects.", PROJETS_COMPTES)}`));
    }
    if (projet) {
      ecrire();
      ecrire(`  ${peindre("bold", projet.name)}  ${peindre("dim", projet.id)}`);
      if (ouverts.length === 0) ecrire(`  ${symbole("pass")} ${t("Rien d'ouvert.", "Nothing open.")}`);
      else lignesIncidents(ouverts, "  ");
      if (ship) ecrire(`  ${ligneShip(ship)}`);
      else ecrire(peindre("dim", `  ${t("Aucun déploiement de production suivi.", "No production deployment tracked.")}`));
    } else if (projets.length > 0) {
      ecrire();
      ecrire(peindre("dim", `  ${t("postship init, ou --project, pour le détail d'un projet.", "postship init, or --project, for a project's detail.")}`));
    }
    ecrire();
    ecrire(peindre("dim", `  ${t("postship watch pour suivre en direct · postship help pour tout le reste", "postship watch to follow live · postship help for everything else")}`));
    ecrire();
  }
  if (!projet) return 0;
  if (ouverts.length > 0) return 1;
  return ship ? codeDuShip(ship, null) : 0;
}

async function open(args) {
  const page = args._[1] && PAGES_OPEN.includes(args._[1]) ? args._[1] : args._[1] ? null : "apercu";
  if (page === null) throw new Error(t("Page inconnue : {0}. Pages : {1}.", "Unknown page: {0}. Pages: {1}.", args._[1], PAGES_OPEN.join(", ")));
  const courant = lireProjet(une(args.project));
  let url = baseUrl();
  if (courant) {
    // L'adresse lisible du projet (/<espace>/<projet>) est celle de l'app :
    // /<uuid> redirige vers elle, ce qui suffit ici.
    const suffixe = { apercu: "", incidents: "/incidents", deploys: "/deploys", urls: "/urls", performance: "/monitoring/performance", reglages: "/settings/general" }[page];
    url = `${baseUrl()}/${encodeURIComponent(courant)}${suffixe}`;
  }
  ecrire(url);
  // L'adresse est écrite dans tous les cas : sans navigateur (SSH,
  // POSTSHIP_NO_BROWSER), elle se copie, et ce n'est pas une erreur.
  if (!ouvrirNavigateur(url) && !process.env.POSTSHIP_NO_BROWSER) return 2;
  return 0;
}

// ---- commands/completion.mjs
// `postship completion bash|zsh|fish|powershell` — les scripts de
// complétion, générés depuis la même table que l'aide (aide.mjs) : une
// commande ajoutée y apparaît sans qu'on y pense.


function optionsDe(nom) {
  return COMMANDES[nom].options.flatMap((o) => o.nom.split(",").map((s) => s.trim())).filter((o) => o.startsWith("--"));
}

function scriptCompletion(shell) {
  const cmds = ORDRE.join(" ");
  if (shell === "bash") {
    const cas = ORDRE.map((c) => `    ${c}) COMPREPLY=( $(compgen -W "${[...optionsDe(c), ...(c === "open" ? PAGES_OPEN : []), ...(c === "completion" ? ["bash", "zsh", "fish", "powershell"] : []), ...(c === "docs" ? ORDRE : [])].join(" ")}" -- "$cur") );;`).join("\n");
    return `# postship — complétion bash. À charger : postship completion bash >> ~/.bashrc
_postship() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds} help" -- "$cur") )
    return
  fi
  case "$cmd" in
${cas}
    help) COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") );;
  esac
}
complete -F _postship postship
`;
  }
  if (shell === "zsh") {
    const descriptions = ORDRE.map((c) => `    '${c}:${COMMANDES[c].resume.en.replace(/'/g, "")}'`).join("\n");
    const cas = ORDRE.map((c) => `    ${c}) _values 'option' ${[...optionsDe(c), ...(c === "open" ? PAGES_OPEN : []), ...(c === "completion" ? ["bash", "zsh", "fish", "powershell"] : []), ...(c === "docs" ? ORDRE : [])].map((o) => `'${o}'`).join(" ")} ;;`).join("\n");
    return `#compdef postship
# postship — complétion zsh. À charger : postship completion zsh >> ~/.zshrc
_postship() {
  local -a commandes
  commandes=(
${descriptions}
  )
  if (( CURRENT == 2 )); then
    _describe 'commande' commandes
    return
  fi
  case "\${words[2]}" in
${cas}
  esac
}
compdef _postship postship
`;
  }
  if (shell === "fish") {
    const lignes = [`# postship — complétion fish. À poser dans ~/.config/fish/completions/postship.fish`, `complete -c postship -f`];
    for (const c of ORDRE) {
      lignes.push(`complete -c postship -n "__fish_use_subcommand" -a ${c} -d "${COMMANDES[c].resume.en.replace(/"/g, "")}"`);
      for (const o of optionsDe(c)) lignes.push(`complete -c postship -n "__fish_seen_subcommand_from ${c}" -l ${o.slice(2)}`);
      if (c === "open") for (const p of PAGES_OPEN) lignes.push(`complete -c postship -n "__fish_seen_subcommand_from open" -a ${p}`);
      if (c === "completion") for (const s of ["bash", "zsh", "fish", "powershell"]) lignes.push(`complete -c postship -n "__fish_seen_subcommand_from completion" -a ${s}`);
      if (c === "docs") for (const d of ORDRE) lignes.push(`complete -c postship -n "__fish_seen_subcommand_from docs" -a ${d}`);
    }
    return lignes.join("\n") + "\n";
  }
  if (shell === "powershell") {
    const table = ORDRE.map((c) => `    '${c}' = @(${[...optionsDe(c), ...(c === "open" ? PAGES_OPEN : []), ...(c === "completion" ? ["bash", "zsh", "fish", "powershell"] : []), ...(c === "docs" ? ORDRE : [])].map((o) => `'${o}'`).join(", ")})`).join("\n");
    return `# postship — complétion PowerShell. À charger : postship completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName postship -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $mots = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $commandes = @(${ORDRE.map((c) => `'${c}'`).join(", ")}, 'help')
  $options = @{
${table}
  }
  if ($mots.Count -le 2 -and -not ($mots.Count -eq 2 -and $wordToComplete -eq '')) {
    $commandes | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $cmd = $mots[1]
  if ($options.ContainsKey($cmd)) {
    $options[$cmd] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
}
`;
  }
  return null;
}

async function completion(args) {
  const shell = args._[1];
  const script = shell ? scriptCompletion(shell) : null;
  if (!script) throw new ErreurCli(t("Shell inconnu : bash, zsh, fish ou powershell.", "Unknown shell: bash, zsh, fish or powershell."), 2);
  process.stdout.write(script);
  return 0;
}

// ---- commands/maj.mjs
// `postship update` et `postship uninstall` (28 sept. 2026) : la CLI se
// met à jour et se retire elle-même, avec le gestionnaire de paquets qui
// l'a installée — npm, pnpm, yarn ou bun, reconnu au chemin du fichier
// lancé. Une CLI lancée par npx, depuis la source ou dans l'action GitHub
// n'est pas une installation globale : on dit quoi faire, sans rien tenter.








/** Le gestionnaire global qui porte cette CLI, ou null (npx, source, action). */
function installation(chemin = process.argv[1] ?? "") {
  let reel = chemin;
  try {
    reel = realpathSync(chemin);
  } catch {
    // chemin fictif (tests) ou disparu : on lit tel quel
  }
  const p = String(reel).replace(/\\/g, "/").toLowerCase();
  if (!p.includes("/node_modules/postship/") || p.includes("/_npx/")) return null;
  if (p.includes("/pnpm/")) return { nom: "pnpm", installer: ["add", "-g", "postship@latest"], retirer: ["remove", "-g", "postship"] };
  if (p.includes("/.bun/")) return { nom: "bun", installer: ["add", "-g", "postship@latest"], retirer: ["remove", "-g", "postship"] };
  if (p.includes("/yarn/")) return { nom: "yarn", installer: ["global", "add", "postship@latest"], retirer: ["global", "remove", "postship"] };
  return { nom: "npm", installer: ["install", "-g", "postship@latest"], retirer: ["uninstall", "-g", "postship"] };
}

/**
 * Lance le gestionnaire, sa sortie sous les yeux. Sur Windows, npm est un
 * .cmd : Node exige alors un shell ; les arguments sont fixes, jamais tapés.
 */
function lancerGestionnaire(nom, liste) {
  const r = spawnSync(nom, liste, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

/** Une question oui/non au clavier : « o » ou « y » valide, tout le reste renonce. */
function confirmerClavier(question, { entree = process.stdin, sortie = process.stdout } = {}) {
  return new Promise((resolve) => {
    sortie.write(question);
    const finir = (ok) => {
      entree.setRawMode?.(false);
      entree.pause();
      entree.off("data", surTouche);
      sortie.write(`${ok ? t("oui", "yes") : t("non", "no")}\n`);
      resolve(ok);
    };
    const surTouche = (buf) => {
      const s = buf.toString().toLowerCase();
      if (s === "o" || s === "y") finir(true);
      else if (s === "n" || s === "\r" || s === "\n" || s === "\u0003" || s === "\u001b") finir(false);
    };
    entree.setRawMode?.(true);
    entree.resume();
    entree.on("data", surTouche);
  });
}

async function update(args, options = {}) {
  const { executer = lancerGestionnaire, chemin, surFin, version = VERSION } = /** @type {{ executer?: (nom: string, liste: string[]) => number, chemin?: string, surFin?: (quoi: string) => void, version?: string }} */ (options);
  if (version.startsWith("__")) {
    ecrire(t("Version de développement (lancée depuis la source) : rien à mettre à jour.", "Development version (run from source): nothing to update."));
    return 0;
  }
  const attente = roue(t("Recherche de la dernière version…", "Looking for the latest version…"));
  let derniere;
  try {
    derniere = await versionPubliee({ forcer: true, delaiMs: 8000 });
  } finally {
    attente.fin();
  }
  if (!derniere) throw new ErreurCli(t("Le registre npm ne répond pas : réessayez dans un instant.", "The npm registry does not answer: try again in a moment."), 2);
  if (!plusRecente(version, derniere)) {
    ecrire(`${symbole("pass")} ${t("Déjà à jour : postship {0}.", "Already up to date: postship {0}.", version)}`);
    return 0;
  }
  if (args.check === true) {
    ecrire(t("postship {0} est disponible (vous avez {1}) : postship update.", "postship {0} is available (you have {1}): postship update.", derniere, version));
    return 0;
  }
  const inst = installation(chemin);
  if (!inst) throw new ErreurCli(t("Cette CLI ne vient pas d'une installation globale (npx, source ou action GitHub) : npm i -g postship@latest.", "This CLI is not a global install (npx, source or GitHub action): npm i -g postship@latest."), 2);
  ecrire(peindre("dim", `  ${inst.nom} ${inst.installer.join(" ")}`));
  const code = executer(inst.nom, inst.installer);
  if (code !== 0) {
    throw new ErreurCli(t("La mise à jour a échoué (code {0}). Sur macOS ou Linux, une installation globale demande parfois sudo : sudo {1} {2}", "The update failed (code {0}). On macOS or Linux, a global install sometimes needs sudo: sudo {1} {2}", code, inst.nom, inst.installer.join(" ")), 2);
  }
  ecrire(`${symbole("pass")} ${peindre("bold", `postship ${version} → ${derniere}`)}`);
  surFin?.("update");
  return 0;
}

/** Ce que la CLI a écrit sur la machine : la config (clé), le cache de version, l'historique de la console. */
function fichiersCli() {
  const dossier = dirname(cheminConfig());
  return [cheminConfig(), cheminCacheVersion(), join(dossier, "historique")];
}

async function uninstall(args, options = {}) {
  const { executer = lancerGestionnaire, chemin, confirmer = confirmerClavier, surFin } = /** @type {{ executer?: (nom: string, liste: string[]) => number, chemin?: string, confirmer?: (question: string) => Promise<boolean>, surFin?: (quoi: string) => void }} */ (options);
  if (args.yes !== true) {
    if (!process.stdin.isTTY) throw new ErreurCli(t("Hors d'un terminal, ajoutez --yes.", "Outside a terminal, add --yes."), 2);
    const ok = await confirmer(t("Désinstaller postship ? La clé de ce terminal sera révoquée et sa configuration effacée. (o/N) ", "Uninstall postship? This terminal's key will be revoked and its configuration deleted. (y/N) "));
    if (!ok) {
      ecrire(t("Rien n'a changé.", "Nothing changed."));
      return 0;
    }
  }
  // 1. La clé : révoquée chez PostShip, pas seulement oubliée ici.
  if (lireConfig().token) {
    try {
      await logout();
    } catch (e) {
      ecrire(peindre("yellow", e?.message ?? String(e)));
    }
  }
  // 2. Les fichiers de la CLI, et leur dossier s'il est vide (jamais un dossier choisi par POSTSHIP_CONFIG).
  for (const f of fichiersCli()) rmSync(f, { force: true });
  if (!process.env.POSTSHIP_CONFIG) {
    try {
      const dossier = dirname(cheminConfig());
      if (readdirSync(dossier).length === 0) rmdirSync(dossier);
    } catch {
      // déjà parti
    }
  }
  ecrire(`${symbole("pass")} ${t("Configuration effacée.", "Configuration deleted.")}`);
  // 3. Le paquet.
  const inst = installation(chemin);
  if (!inst) {
    ecrire(t("Cette CLI ne vient pas d'une installation globale : retirez-la comme vous l'avez installée.", "This CLI is not a global install: remove it the way you installed it."));
  } else {
    const code = executer(inst.nom, inst.retirer);
    if (code !== 0) throw new ErreurCli(t("La désinstallation a échoué (code {0}) : {1} {2}", "Uninstalling failed (code {0}): {1} {2}", code, inst.nom, inst.retirer.join(" ")), 2);
    ecrire(`${symbole("pass")} ${t("postship est désinstallé. Merci de l'avoir essayé.", "postship is uninstalled. Thanks for trying it.")}`);
  }
  if (process.env.POSTSHIP_TOKEN) ecrire(peindre("yellow", t("POSTSHIP_TOKEN reste posé dans votre environnement : retirez-le, ou révoquez la clé dans Réglages de l'espace → API.", "POSTSHIP_TOKEN is still set in your environment: unset it, or revoke the key in Workspace settings → API.")));
  surFin?.("uninstall");
  return 0;
}

// ---- postship.mjs
// PostShip — la CLI officielle. Un binaire qui parle à
// https://postship.fr/api/v1 comme un humain parlerait à l'Aperçu.
//
// Aucune dépendance, volontairement : un outil qu'on ajoute à une CI ne
// doit pas y ajouter un arbre de modules. Node 18+ (fetch natif).
//
//   postship login                      # connecte ce terminal au compte
//   postship                            # l'interface plein écran (dans un terminal)
//   postship check exemple.fr           # vérifie, compte dans le quota
//   git push && postship wait --head    # le verdict du commit qu'on pousse
//
// Le seul contrat qui compte pour un workflow est le code de sortie :
//   0  le site (ou la lecture) est bon, seuil atteint
//   1  le site a un problème (fail, score sous le seuil, incidents ouverts avec --fail-if-open)
//   2  l'outil n'a pas pu se prononcer (jeton, quota, réseau, usage, projet introuvable)
























/** `postship docs [commande]` : la page du site, dans le navigateur. */
async function docs(args) {
  const commande = args._[1];
  if (commande && !COMMANDES[commande]) throw new ErreurCli(t("Commande inconnue : {0}", "Unknown command: {0}", commande), 2);
  const url = `${baseUrl().includes("localhost") ? "https://postship.fr" : baseUrl()}/docs/cli${commande ? `#cli-${commande}` : ""}`;
  ecrire(url);
  return ouvrirNavigateur(url) ? 0 : 0;
}

const FONCTIONS = { login, logout, status, check, projects, incidents, ship, ships, urls, wait, gate, watch, open, whoami, doctor, init, update, uninstall, completion, docs };

/** L'aide générale, ou celle d'une commande : description, options, exemples, codes de sortie, dépannage. */
function aide(commande) {
  const l = langue();
  if (commande && COMMANDES[commande]) {
    const c = COMMANDES[commande];
    ecrire(`${peindre("bold", `postship ${commande}`)} — ${c.resume[l]}${c.quota ? peindre("dim", l === "fr" ? "  (compte dans le quota)" : "  (counts toward the quota)") : ""}`);
    ecrire();
    ecrire(`  ${c.usage}`);
    ecrire();
    for (const ligne of replier(c.description[l], 76)) ecrire(`  ${ligne}`);
    if (c.options.length > 0) {
      ecrire();
      ecrire(peindre("bold", l === "fr" ? "Options" : "Options"));
      const largeur = Math.max(...c.options.map((o) => `${o.nom}${o.valeur ? ` ${o.valeur}` : ""}`.length));
      for (const o of c.options) {
        const nom = `${o.nom}${o.valeur ? ` ${o.valeur}` : ""}`.padEnd(largeur);
        const [premiere, ...suite] = replier(o.texte[l], 74 - largeur);
        ecrire(`  ${nom}  ${premiere}`);
        for (const s of suite) ecrire(`  ${" ".repeat(largeur)}  ${s}`);
      }
    }
    ecrire();
    ecrire(peindre("bold", l === "fr" ? "Exemples" : "Examples"));
    for (const e of c.exemples) {
      ecrire(`  ${e.cmd}`);
      ecrire(peindre("dim", `    ${e.texte[l]}`));
    }
    ecrire();
    ecrire(peindre("bold", l === "fr" ? "Codes de sortie" : "Exit codes"));
    for (const ligne of replier(c.sortie[l], 76)) ecrire(`  ${ligne}`);
    if (c.depannage.length > 0) {
      ecrire();
      ecrire(peindre("bold", l === "fr" ? "Dépannage" : "Troubleshooting"));
      for (const d of c.depannage) {
        ecrire(`  ${d.q[l]}`);
        for (const ligne of replier(d.r[l], 72)) ecrire(peindre("dim", `    ${ligne}`));
      }
    }
    ecrire();
    ecrire(peindre("dim", l === "fr" ? `postship docs ${commande} ouvre la page complète sur postship.fr.` : `postship docs ${commande} opens the full page on postship.fr.`));
    return;
  }
  ecrire();
  ecrire(`  ${marque(peindre("dim", `${VERSION.startsWith("__") ? "dev" : VERSION} · ${l === "fr" ? "vos déploiements, vérifiés depuis le terminal" : "your deploys, checked from the terminal"}`))}`);
  ecrire();
  ecrire(l === "fr" ? "  postship               l'interface plein écran (dans un terminal)" : "  postship               the full-screen interface (in a terminal)");
  ecrire(l === "fr" ? "  postship <commande> [options]" : "  postship <command> [options]");
  for (const groupe of GROUPES) {
    ecrire();
    ecrire(`  ${peindre("bold", groupe[l])}`);
    for (const nom of groupe.commandes) ecrire(`    ${nom.padEnd(12)} ${peindre("dim", COMMANDES[nom].resume[l])}`);
  }
  ecrire();
  ecrire(l === "fr" ? "  postship help <commande>   les options, des exemples, les codes de sortie" : "  postship help <command>    options, examples, exit codes");
  ecrire(l === "fr" ? "  postship docs [commande]   la documentation sur postship.fr" : "  postship docs [command]    the documentation on postship.fr");
  ecrire();
  ecrire(l === "fr" ? "  La clé : postship login (~/.config/postship), ou POSTSHIP_TOKEN. Jamais en argument." : "  The key: postship login (~/.config/postship), or POSTSHIP_TOKEN. Never as an argument.");
  ecrire(l === "fr" ? "  Le projet : --project, ./.postship.json (postship init), ou POSTSHIP_PROJECT." : "  The project: --project, ./.postship.json (postship init), or POSTSHIP_PROJECT.");
  ecrire(l === "fr" ? "  Codes de sortie : 0 bon · 1 le site a un problème · 2 l'outil n'a pas pu se prononcer." : "  Exit codes: 0 good · 1 the site has a problem · 2 the tool could not tell.");
}

/** Replie un texte à la largeur, sur les espaces. */
function replier(texte, largeur) {
  const mots = String(texte).split(/\s+/);
  const lignes = [];
  let courante = "";
  for (const mot of mots) {
    if (courante && (courante + " " + mot).length > largeur) {
      lignes.push(courante);
      courante = mot;
    } else {
      courante = courante ? `${courante} ${mot}` : mot;
    }
  }
  if (courante) lignes.push(courante);
  return lignes;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const commande = args._[0];

  if (args.version === true || commande === "version" || commande === "--version" || commande === "-v") {
    ecrire(VERSION.startsWith("__") ? "dev" : VERSION);
    return 0;
  }
  // `postship` seul, dans un terminal : l'interface plein écran. Hors
  // terminal (script, tube, CI), l'aide et le code 2, comme avant : un
  // appel sans commande y est une erreur. Une commande qui a besoin du
  // terminal (update, uninstall, init…) quitte l'interface puis s'exécute.
  if (!commande && process.stdout.isTTY && process.stdin.isTTY && process.env.CI !== "true" && args.help !== true) {
    const suite = await lancerInterface({
      ...FONCTIONS,
      help: async (a) => {
        aide(a._[1]);
        return 0;
      },
    });
    return suite ? main(suite) : 0;
  }
  if (!commande || commande === "help" || commande === "--help") {
    aide(args._[1]);
    return commande ? 0 : 2;
  }
  if (args.help === true) {
    aide(FONCTIONS[commande] ? commande : undefined);
    return 0;
  }
  // Le jeton ne passe jamais en argument : la flag n'existe pas, et on le dit.
  if (args.token !== undefined) {
    ecrireErreur(t("--token n'existe pas : postship login, ou POSTSHIP_TOKEN.", "--token does not exist: postship login, or POSTSHIP_TOKEN."));
    return 2;
  }
  const fn = FONCTIONS[commande];
  if (!fn) {
    ecrireErreur(t("Commande inconnue : {0}", "Unknown command: {0}", commande));
    aide();
    return 2;
  }
  let code;
  try {
    code = await fn(args);
  } catch (erreur) {
    if (erreur instanceof ErreurCli) {
      ecrireErreur(erreur.message);
      code = erreur.code;
    } else {
      ecrireErreur(erreur?.message ?? String(erreur));
      code = 2;
    }
  }
  if (!["completion", "docs", "update", "uninstall"].includes(commande)) await avisDeVersion({ json: args.json === true });
  return code;
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

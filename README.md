# PostShip check

Vérifie une URL depuis un workflow GitHub, comme PostShip le fait après un déploiement — HTTP, ressources, indexabilité, carte sociale, sitemap, certificat. Même Ship Score. Le step échoue si une vérification échoue ou si le score est sous le seuil.

```yaml
- uses: titilyonnais/postship-check@v1
  with:
    url: ${{ steps.preview.outputs.url }}
    token: ${{ secrets.POSTSHIP_TOKEN }}
    min-score: 80
```

`token` est une clé d'API PostShip (Compte → API sur postship.fr), à passer **via un secret de dépôt** — jamais en clair. `min-score` est facultatif (`0` = pas de seuil).

Codes de sortie : `0` tout est passé · `1` le site a un problème · `2` l'outil n'a pas pu se prononcer (jeton, quota, réseau).

Le fichier `postship.mjs` est la CLI officielle assemblée en un seul fichier (`npm i -g postship` ailleurs) : `node postship.mjs help`.

Documentation : https://postship.fr/docs/cli#cli-ci

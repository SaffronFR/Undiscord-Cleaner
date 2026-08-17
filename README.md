# Undiscord-Cleaner

Suppression automatique des anciens messages Discord, conçu pour tourner sur un VPS Ubuntu (24/7) via Docker. Utilise l'API Discord directement (sans navigateur) et gère la suppression en continu selon un planning.

## Fonctionnalités

- **Nettoyage planifié** : suppression des messages plus vieux qu'un âge défini, toutes les X heures
- **Exclusion de serveurs** : liste de guilds à ignorer
- **Webhook de notification** : progression en direct (message édité en continu), logs bufferisés avec rotation
- **Rotation des logs** : fichiers de logs limités en taille (4 Go max)
- **Déploiement Docker** : une seule commande pour construire et lancer

## Configuration

Copiez les fichiers de modèle puis remplissez vos valeurs :

```bash
cp .env.example .env
cp config.example.json config.json
```

| Variable | Rôle |
| --- | --- |
| `DISCORD_TOKEN` | Token Discord (obligatoire) |
| `DISCORD_AUTHOR_ID` | ID de l'auteur dont les messages sont supprimés (vide = auto-détection) |
| `EXCLUDED_GUILDS` | IDs de serveurs exclus, séparés par des virgules |
| `SCHEDULE_INTERVAL_HOURS` | Intervalle entre deux cycles de nettoyage (heures) |
| `CLEANUP_MAX_AGE_DAYS` | Âge maximum des messages à conserver (jours) |
| `CLEANUP_SEARCH_DELAY` | Délai entre deux recherches API (ms) |
| `CLEANUP_DELETE_DELAY` | Délai entre deux suppressions (ms) |
| `WEBHOOK_URL` | URL du webhook Discord pour les notifications (optionnel) |
| `WEBHOOK_MIN_LEVEL` | Niveau minimal de log envoyé au webhook (`debug` \| `info` \| `warn` \| `error`) |

> Les variables d'environnement (`.env`) sont prioritaires sur `config.json`.

## Déploiement (VPS Ubuntu)

### Avec Docker (recommandé)

```bash
# 1. Configure le .env
cp .env.example .env
nano .env

# 2. Build & lancement
./run.sh

# 3. Suivi
docker compose logs -f
```

### Sans Docker

```bash
npm install
npm start
```

### En service systemd (optionnel)

Copiez `undiscord-cleanup.service` dans `/etc/systemd/system/`, ajustez le chemin d'installation puis :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now undiscord-cleanup
```

## Santé

Un healthcheck expose `http://localhost:3000` (HTTP 200 = OK).

## Avertissement

L'utilisation de ce projet avec un compte Discord peut violer les conditions d'utilisation de Discord. Utilisez-le à vos propres risques, uniquement sur des comptes et serveurs que vous contrôlez.

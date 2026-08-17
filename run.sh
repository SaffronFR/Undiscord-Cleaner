#!/bin/bash
# run.sh - Déploiement VPS Ubuntu
set -e

echo "🚀 Déploiement Undiscord VPS Auto-Cleanup"

# 1. Update système
sudo apt update && sudo apt upgrade -y

# 2. Docker
if ! command -v docker &> /dev/null; then
    echo "📦 Installation Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    sudo usermod -aG docker $USER
fi

# 3. Config
if [ ! -f .env ]; then
    echo "⚠️  Fichier .env introuvable !"
    cp .env.example .env
    echo "✏️  Édite .env avec ton token Discord, puis relance run.sh"
    nano .env
fi

# 4. Build & lancement
echo "📦 Build Docker image..."
docker compose build --no-cache

echo "🚀 Lancement du conteneur..."
docker compose up -d --remove-orphans

echo "✅ Conteneur lancé !"
echo "📋 Logs: docker compose logs -f"
echo "🛑 Arrêt: docker compose down"
echo "🔄 Rebuild: docker compose build --no-cache && docker compose up -d"

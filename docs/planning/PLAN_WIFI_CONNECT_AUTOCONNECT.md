# PLAN : WiFi Connect from Scan + Auto-Connect

> Genere par `/ai-plan-interview` le 2026-03-06

## 1. Contexte et objectif

Ameliorer le workflow WiFi roaming du dashboard seamless-wan :

1. Permettre de se connecter a un reseau inconnu depuis les resultats de scan (saisie du mot de passe via modal, ajout automatique aux reseaux connus)
2. Ajouter un flag auto-connect aux reseaux connus (actif par defaut)
3. Modifier le daemon wifi-roaming.sh pour auto-connecter au meilleur reseau connu disponible
4. Roaming sur seuil : si le signal tombe sous -75 dBm, chercher un meilleur reseau connu
5. Si la connexion echoue apres "Connect+Add", supprimer le reseau de la config

## 2. Approche architecturale

Approche directe — le scope est petit et le codebase bien defini. Pas d'abstractions supplementaires necessaires.

## 3. Criteres d'acceptation

- [ ] Un bouton "Connect" apparait sur les reseaux inconnus dans les resultats de scan
- [ ] Cliquer dessus ouvre le modal avec SSID pre-rempli (non editable) + champ password + priority + checkbox "manual only"
- [ ] Le reseau est ajoute a la config ET la connexion est lancee
- [ ] Si la connexion echoue, le reseau est supprime de la config
- [ ] Les reseaux connus affichent un badge "auto" ou "manual"
- [ ] Le modal edit permet de changer le flag autoconnect
- [ ] Le daemon se connecte automatiquement au meilleur reseau connu (autoconnect=true) quand deconnecte
- [ ] Le daemon bascule vers un meilleur reseau si le signal tombe sous -75 dBm
- [ ] Le format de config est retro-compatible (lignes a 3 champs = auto par defaut)

## 4. Analyse technique

### Fichiers a modifier

| Fichier | Modification |
|---------|-------------|
| `config/wifi-roaming.conf` | Documenter le nouveau format 4 champs |
| `dashboard/models.py` | Ajouter `autoconnect: bool` a `KnownNetwork` |
| `dashboard/host_commands.py` | Parser/ecrire le 4e champ, nouveau endpoint connect+add |
| `dashboard/server.py` | Endpoint `POST /api/roaming/connect-and-add`, passer autoconnect dans CRUD |
| `dashboard/static/index.html` | Checkbox "manual only" dans le modal |
| `dashboard/static/dashboard.js` | Bouton Connect sur inconnus, pre-remplir modal, workflow connect+add, afficher badge auto/manual |
| `scripts/host/wifi-roaming.sh` | Daemon auto-connect + roaming sur seuil + scan trigger/dump |

### Migration DB

Non applicable (fichier plat wifi-roaming.conf).

### Format wifi-roaming.conf

```
# Actuel (3 champs)
SSID|key|priority

# Nouveau (4 champs, retro-compatible)
SSID|key|priority|auto
SSID|key|priority|manual

# Lignes a 3 champs sont traitees comme "auto" (defaut)
```

## 5. Wireframes

### Resultats de scan (reseaux inconnus avec bouton Connect)

```
Available Networks
┌─────────────────────────────────────────────────┐
│ ▓▓▓▓  ASTRAL0      -41 dBm  (known)  [Connect] │
│ ▓▓▓   SFR_FB8F     -73 dBm           [Connect] │  ← NEW
│ ▓▓▓   Livebox-5240 -59 dBm           [Connect] │  ← NEW
│ ▓▓    BB House     -71 dBm           [Connect] │  ← NEW
└─────────────────────────────────────────────────┘
```

### Modal Connect+Add (reseau inconnu)

```
┌──────────────────────────────────┐
│  Connect to SFR_FB8F             │
│                                  │
│  SSID                            │
│  [SFR_FB8F__________] (disabled) │
│                                  │
│  Password ("open" for open nets) │
│  [________________________]      │
│                                  │
│  Priority (1=best, 100=worst)    │
│  [10_____]                       │
│                                  │
│  [x] Auto-connect               │
│                                  │
│       [Cancel]       [Connect]   │
└──────────────────────────────────┘
```

### Known Networks (avec badge auto/manual)

```
Known Networks
┌─────────────────────────────────────────────────────┐
│  1  ASTRAL0   ****  [auto]     [Edit] [Del]         │
│  2  DOOM      ****  [auto]     [Edit] [Del]         │
│ 10  Galaxy    ****  [manual]   [Edit] [Del]         │
└─────────────────────────────────────────────────────┘
[+ Add Network]
```

## 6. Plan d'implementation

### Etape 1 : Backend — modele et parsing (models.py, host_commands.py)

- [ ] 1.1 Ajouter `autoconnect: bool = True` a `KnownNetwork` dans models.py
- [ ] 1.2 Ajouter `autoconnect` a `KnownNetwork.to_dict()` et `key_display`
- [ ] 1.3 Modifier `get_known_networks()` : parser le 4e champ (defaut `auto`)
- [ ] 1.4 Modifier `add_known_network()` : accepter param `autoconnect`, ecrire 4 champs
- [ ] 1.5 Modifier `update_known_network()` : accepter param `autoconnect`, ecrire 4 champs
- [ ] 1.6 Ajouter `connect_and_add_network(ssid, key, priority, autoconnect)` :
  - Ajouter le reseau a la config
  - Lancer la connexion
  - Si echec apres 10s, supprimer le reseau de la config
  - Retourner un `CommandResult` avec le status

### Etape 2 : Backend — API (server.py)

- [ ] 2.1 Ajouter `POST /api/roaming/connect-and-add` : body `{ssid, key, priority, autoconnect}`, appelle `connect_and_add_network()`
- [ ] 2.2 Modifier `POST /api/roaming/networks` : accepter `autoconnect` (defaut true)
- [ ] 2.3 Modifier `PUT /api/roaming/networks/{ssid}` : accepter `autoconnect`

### Etape 3 : Frontend (index.html, dashboard.js)

- [ ] 3.1 Ajouter checkbox "Manual only (no auto-connect)" dans le modal `modal-network`
- [ ] 3.2 Modifier `showAddModal()` : accepter parametre `ssid` optionnel pour pre-remplir
- [ ] 3.3 Ajouter bouton "Connect" sur les reseaux inconnus dans `doScan()` → ouvre le modal pre-rempli
- [ ] 3.4 Modifier `saveNetwork()` : si SSID vient du scan (nouveau reseau), appeler `/api/roaming/connect-and-add` au lieu de juste `/api/roaming/networks`
- [ ] 3.5 Afficher badge "auto"/"manual" dans `loadKnownNetworks()`
- [ ] 3.6 Pre-remplir la checkbox autoconnect dans `showEditModal()`

### Etape 4 : Daemon wifi-roaming.sh

- [ ] 4.1 Modifier `load_networks()` pour parser le 4e champ (auto/manual)
- [ ] 4.2 Modifier `do_daemon()` : quand deconnecte, auto-connecter au meilleur reseau connu avec `autoconnect=auto`
- [ ] 4.3 Ajouter roaming sur seuil : si connecte et signal < -75 dBm, scanner et basculer vers un meilleur reseau connu (autoconnect=auto, meilleure priorite)
- [ ] 4.4 Utiliser `scan trigger` + `scan dump` dans le daemon (comme corrige dans do_scan)
- [ ] 4.5 Logger les evenements d'auto-connect et de roaming

### Etape 5 : Deploiement sur le RPi

- [ ] 5.1 Copier les fichiers modifies vers le RPi (`scp -O`, fix CRLF)
- [ ] 5.2 Redemarrer le service dashboard
- [ ] 5.3 Redemarrer le service wifi-roaming
- [ ] 5.4 Tester le workflow complet (scan → connect unknown → verify config → disconnect → verify auto-reconnect)

## 7. Edge cases

| ID | Description | Strategie |
|----|-------------|-----------|
| EC-1 | Connexion echoue (mauvais mdp) apres Connect+Add | Supprimer le reseau de la config, afficher erreur |
| EC-2 | SSID avec caracteres speciaux (espaces, accents) | Deja gere par `shell_escape()` + validation SSID |
| EC-3 | Reseau ouvert (pas de mdp) | `key=open`, deja supporte |
| EC-4 | Daemon + connexion manuelle simultanee | `_write_lock` protege les ecritures concurrentes |
| EC-5 | Signal fluctuant autour du seuil -75 dBm | Hysteresis : ne basculer que si le nouveau reseau a > 10 dBm de mieux |
| EC-6 | Aucun reseau connu autoconnect disponible | Le daemon ne fait rien, continue a scanner |
| EC-7 | wifi-roaming.conf avec anciennes lignes 3 champs | Retro-compatible : 3 champs = autoconnect par defaut |

## 8. Limitations connues

- Pas de HTTPS (prevu dans une evolution future)
- Le MT7601U ne peut scanner que tous les ~60s (scan trigger prend ~3s)
- Le roaming coupe la connexion pendant ~5s lors du changement de reseau
- Pas de test de bande passante pour choisir le meilleur reseau (uniquement signal + priorite)

## 9. Tests (verification manuelle sur RPi)

### Scenarios de test

| # | Scenario | Verification |
|---|----------|-------------|
| T1 | Scan affiche bouton Connect sur reseaux inconnus | Bouton visible, pas de bouton sur "(known)" |
| T2 | Clic Connect → modal pre-rempli | SSID disabled, password vide, priority=10, autoconnect=checked |
| T3 | Connect+Add reseau avec bon mdp | Reseau ajoute a la config + connexion etablie |
| T4 | Connect+Add reseau avec mauvais mdp | Erreur affichee + reseau PAS dans la config |
| T5 | Connect+Add reseau ouvert | password="open", connexion OK |
| T6 | Known networks affichent badge auto/manual | Badges visibles et corrects |
| T7 | Edit reseau → changer autoconnect | Flag mis a jour dans la config |
| T8 | Daemon auto-connect quand deconnecte | Deconnecter manuellement, verifier reconnexion auto en <60s |
| T9 | Daemon roaming sur seuil | Simuler signal faible (s'eloigner du routeur), verifier bascule |
| T10 | Retro-compatibilite config 3 champs | Anciennes lignes traitees comme autoconnect=true |

### Commandes de verification

```sh
# Verifier la config apres Connect+Add
ssh root@192.168.100.1 "cat /etc/wifi-roaming.conf"

# Verifier les logs du daemon
ssh root@192.168.100.1 "logread | grep wifi-roaming | tail -20"

# Tester l'API directement
ssh root@192.168.100.1 "curl -s -b /tmp/dash_cookies http://127.0.0.1:8080/api/roaming/networks"
```

## 10. Estimation d'effort

| Composant | Estimation | Notes |
|-----------|------------|-------|
| Backend models + parsing | 0.5h | Ajout champ autoconnect |
| Backend API | 0.5h | 1 nouvel endpoint + modif 2 existants |
| Frontend JS/HTML | 1h | Modal, boutons, badges |
| Daemon wifi-roaming.sh | 1h | Auto-connect + roaming seuil |
| Deploiement + tests | 0.5h | scp + verification |
| **Total** | **3.5h** | |

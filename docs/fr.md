# Devialet

Pilotez vos enceintes **Devialet Phantom** depuis Gladys, sur votre réseau
local, sans aucun cloud : volume, sourdine, source, lecture, pause, suivant,
précédent, le titre en cours, et la mise en veille. L'intégration utilise
l'API de contrôle IP que les enceintes proposent sur votre réseau (HTTP
simple), celle qu'utilise l'intégration Devialet de Home Assistant.

> **Intégration non officielle, sans lien avec Devialet.** Ce premier jalon a
> été écrit et vérifié contre une enceinte simulée seulement : l'intégration
> n'a **jamais été testée avec une vraie enceinte**. Vos retours sont les
> bienvenus.

## Préparer les enceintes

1. Installez les enceintes avec l'application Devialet comme d'habitude
   (Wi-Fi ou Ethernet).
2. Donnez à chaque enceinte une **adresse IP fixe** dans votre box (bail DHCP
   réservé). L'adresse est visible dans l'application Devialet, ou dans la
   liste des appareils de votre box.
3. Gladys doit joindre les enceintes sur le réseau (même réseau, port 80).

## Ajouter une enceinte

- **Par son adresse** (conseillé) : saisissez l'adresse IP dans « Adresses IP
  des enceintes » (plusieurs adresses séparées par des virgules) et
  enregistrez. Pour une **paire stéréo**, une seule adresse suffit : les deux
  enceintes forment un seul système ; si les deux sont saisies, un seul
  appareil est affiché.
- **Par la recherche** (facultatif) : utilisez **Chercher les enceintes**.
  Gladys parcourt le réseau (mDNS, service `_devialet-http._tcp`) pour
  l'intégration. Une enceinte en veille, ou un réseau qui bloque le
  multicast, peut ne pas répondre : saisissez alors l'adresse. La recherche
  n'est jamais nécessaire au reste.

L'enceinte apparaît dans l'onglet **Découverte** de l'intégration : créez-la.

## Ce que vous obtenez

Un appareil Gladys par **système** Devialet (une Phantom, ou une paire
stéréo) :

| Fonction        | Détail                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| Marche          | Lecture seule : 1 l'enceinte répond, 0 en veille, éteinte ou injoignable    |
| Veille          | Bouton : met le système en veille                                           |
| Volume          | 0 à 100, lu et réglé (nombres entiers seulement)                            |
| Sourdine        | Bouton : chaque appui lit la sourdine sur l'enceinte et règle l'inverse     |
| Lecture, Pause  | Boutons                                                                     |
| Suivant, Préc.  | Boutons                                                                     |
| État de lecture | Lecture seule : 1 en lecture, 0 en pause                                    |
| Source          | Liste, lue et réglée : les sources que cette enceinte a montrées (AirPlay…) |
| En cours        | Texte : « Artiste - Titre », ou « — » quand rien ne joue                    |

Le volume et la veille agissent sur le **système**. La lecture, la sourdine et
la source agissent sur le **groupe** : quand plusieurs systèmes jouent
ensemble (groupés dans l'application Devialet), une commande passée par l'un
d'eux s'applique à tout le groupe.

La liste « Source » reprend les sources que l'enceinte annonce (Spotify
Connect, AirPlay, Bluetooth, UPnP, Roon Ready, optique…). Sur une paire
stéréo, l'entrée optique de chaque enceinte est indiquée avec son côté
(« Optical left », « Optical right »). Une source vue une fois reste dans la
liste ; choisir une source indisponible à ce moment est refusé et rien n'est
envoyé.

## Veille, et allumage

L'API de contrôle IP **ne sait pas réveiller une enceinte** : il n'existe pas
de commande « allumer ». C'est pourquoi la marche est un état en lecture seule
et la veille un bouton, pas un interrupteur : un « tout allumer » n'aurait
rien à envoyer. Une enceinte se réveille d'elle-même quand on lui envoie de la
musique (AirPlay, Spotify Connect…), ou depuis l'application Devialet ou sa
surface tactile.

Une enceinte en veille ne répond pas au réseau : elle est affichée à **0**
(veille, éteinte ou injoignable), le statut de l'intégration la nomme, et elle
est redemandée de moins en moins souvent : après l'intervalle de
rafraîchissement, puis deux fois plus longtemps à chaque fois, 5 minutes au
plus. Dès qu'elle répond, elle est relue à l'intervalle normal. Une enceinte
qui accepte la connexion puis ne dit rien est dans un état **inconnu** : rien
n'est publié, Gladys garde le dernier état connu.

Appuyer sur **Veille** pour une enceinte qui ne répond pas ne fait rien et
n'est pas une erreur (elle est déjà en veille, ou hors du réseau).

## Commandes

Chaque commande reçoit sa réponse dans les 5 secondes qu'attend Gladys. Les
commandes vers une même enceinte partent une à une ; une commande qui ne peut
pas partir à temps est abandonnée, jamais envoyée en retard. Un volume qui
n'est pas un nombre entier de 0 à 100 (vide, 12,5, texte…) est refusé avant
tout envoi. Quand l'enceinte a reçu une commande sans la confirmer à temps,
Gladys affiche « envoyée, sans confirmation » et l'état est relu deux
secondes plus tard.

## Réglages

- **Intervalle de rafraîchissement** : fréquence de lecture du volume, de la
  sourdine, de la source et du titre, de 5 à 300 secondes (10 par défaut).
- **Vérifier les enceintes** : interroge tout de suite chaque enceinte connue
  et indique celles qui répondent, avec leur volume.

## Vie privée et sécurité

L'intégration ne parle qu'aux enceintes, sur votre réseau local, en HTTP
simple (les enceintes ne proposent rien d'autre). Elle garde la liste des
enceintes connues (numéro de série, adresse, nom, sources) dans son dossier
de données (`/data`). Il n'y a ni compte ni mot de passe. Les réponses des
enceintes sont lues avec une taille maximale (64 Ko), et seuls les champs
attendus sont gardés.

## Limites

- Réseau local seulement ; l'API est celle du logiciel des enceintes, qui peut
  changer.
- Pas d'« allumer » (voir plus haut), ni égaliseur ni mode nuit, ni lecture de
  notifications dans cette première version.
- Jamais testée avec une vraie enceinte à ce jour.

## Crédits

Logique portée en JavaScript depuis
[devialet](https://github.com/fwestenberg/devialet) de fwestenberg (licence
MIT), la bibliothèque de l'intégration Devialet de Home Assistant. Devialet et
Phantom sont des marques de Devialet, citées seulement pour nommer les
produits compatibles.

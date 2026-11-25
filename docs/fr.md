# Global Caché

Cette intégration relie à Gladys les passerelles Global Caché de votre réseau : iTach (IP2IR, WF2IR,
IP2CC, WF2CC), Flex, GC-100 et Global Connect. Elle passe par l’API TCP unifiée officielle de Global
Caché (port 4998), en local, sans compte ni cloud.

**Intégration non officielle, sans lien avec Global Caché. Écrite d’après le manuel officiel « Unified
TCP API » 1.1.2, elle n’a jamais été testée avec un vrai appareil** : vos retours sont précieux.

## Ce qu’elle fait

- **Codes infrarouges** depuis les scènes : action « Émettre un code infrarouge » (passerelle,
  connecteur, code).
- **Relais** (iTach IP2CC/WF2CC, GC-100-12/18, Flex avec le câble relais et capteurs, Global Connect
  Relay) : l’état du contact (lecture seule), un bouton « impulsion » et un bouton « relâcher ».
- **Entrées** (port IR réglé en capteur, module capteurs, câble Flex relais et capteurs) : lues à
  l’intervalle choisi (30 s par défaut).

## Installation

1. Donnez à chaque passerelle une **adresse fixe** (réservation DHCP) : l’API ne donne ni numéro de
   série ni adresse MAC, l’adresse est donc l’identité de la passerelle dans Gladys. Une autre adresse
   ferait un nouvel appareil.
2. Dans la configuration, indiquez les adresses (par ex. `192.168.1.70, 192.168.1.71`), 8 au plus.
   Ajoutez `:port` seulement si ce n’est pas 4998.
3. Enregistrez, puis ouvrez la **Découverte** et ajoutez les passerelles.

L’intégration ouvre une connexion par lecture ou par commande et la ferme aussitôt : un GC-100, qui
n’accepte qu’une connexion à la fois, reste disponible pour vos autres applications entre deux
échanges.

## Codes infrarouges

Dans une scène, choisissez l’action « Émettre un code infrarouge », la passerelle, le connecteur
(`module:port`, par ex. `1:1` sur un iTach, `4:2` sur un GC-100 ; la liste des sorties est dans les
paramètres de l’appareil, `ir_ports`) et le code. Formats acceptés :

- une ligne `sendir` entière : `sendir,1:1,1,38000,1,1,342,171,21,21,...` (son connecteur sert si le
  champ est vide ; s’il diffère du champ, rien n’est envoyé) ;
- la même sans le début : `38000,1,1,342,171,21,21,...` (fréquence, répétitions, décalage, durées) ;
- un code Pronto appris (`0000 006D 0000 0022 ...`), converti par l’intégration.

Le format compressé de Global Caché (avec des lettres) n’est pas pris en charge. Les codes se trouvent
dans la base Control Tower de Global Caché ou s’apprennent avec l’outil iLearn.

Avant d’envoyer, l’intégration vérifie le code d’après les bornes du manuel (fréquence de 15 000 à
500 000 Hz, 20 000 au moins pour un GC-100 ; 1 à 20 répétitions ; durées de 1 à 50 000 ; durées par
paires ; 512 durées au plus ; 5 s d’émission au plus, répétitions comprises), puis relit l’identité de
la passerelle et le mode du port : un port réglé en capteur n’émet rien. L’action renvoie `confirmed`
(fin d’émission confirmée par la passerelle). Sans cette confirmation, le code a pu partir : la scène
continue et la variable vaut faux. Le bouton « Essayer un code infrarouge » de la configuration fait la
même chose.

## Relais

Un relais peut commander un portail, une porte de garage ou un store. Chaque relais donne trois
fonctions :

- **Relais 1:1 (contact)** : 1 contact fermé, 0 ouvert, lu à chaque lecture ;
- **Relais 1:1 : impulsion** : ferme le contact pendant la « Durée de l’impulsion » (500 ms par
  défaut, de 100 à 10 000 ms), puis l’ouvre ;
- **Relais 1:1 : relâcher** : ouvre le contact tout de suite.

Ce sont des boutons, jamais des interrupteurs : une scène « tout éteindre » ou « tout allumer » ne les
touche pas. Seuls les relais simples (SPST) sont proposés ; sur un Flex, un relais configuré en SPDT ou
DPDT n’est pas proposé.

### L’impulsion, désactivée par défaut

L’impulsion est refusée, sans rien envoyer au relais, dans ces cas :

- l’option « Autoriser les relais » est décochée (elle est relue juste avant l’envoi) ;
- `/data` est illisible, ou n’a pas pu garder le relâchement à venir (2 s au plus) ;
- une impulsion de ce relais est en cours, ou son relâchement n’est pas encore confirmé ;
- un relâchement de ce relais a été demandé pendant que l’impulsion attendait ;
- la passerelle n’est pas encore créée dans Gladys, ou un autre modèle répond à son adresse ;
- le port n’est plus un relais simple de la passerelle ;
- le relais est lu fermé juste avant ;
- la passerelle est injoignable, répond de façon inattendue ou trop lentement (Gladys attend 5 s) ;
- 8 commandes attendent déjà pour cette passerelle ;
- l’intégration s’arrête.

Juste avant l’envoi, l’intégration relit sur la même connexion le modèle de la passerelle, ses modules
et l’état du relais, puis écrit dans `/data` le relâchement à venir. Le relâchement part après la durée
de l’impulsion, même si la passerelle n’a pas répondu à l’impulsion.

### Le relâchement

Le relâchement (ouvrir le contact) ne dépend ni de l’option, ni de la
configuration pas encore lue, ni d’une lecture ou d’une commande en cours ; il ne lui faut que l’adresse
de la passerelle, que porte l’appareil. Il passe devant tout : il annule
les impulsions de ce relais qui attendent, coupe tout de suite une lecture, et coupe une commande en
cours si la passerelle n’a rien dit depuis 1 s. Il est confirmé par une lecture du relais faite après
lui.

Il n’aboutit pas seulement si la passerelle ne répond pas (ou si l’intégration est en train de
s’arrêter) : il est alors gardé dans `/data`, renvoyé
par les 3 lectures suivantes qui réussissent et à chaque démarrage de l’intégration (avant même la
lecture de la configuration), et le statut le signale. Un redémarrage pendant une impulsion relâche
donc le relais au démarrage suivant.

## Statut

L’écran de configuration montre, par passerelle, le modèle, le nombre de relais et d’entrées, la
dernière commande, et les relâchements pas encore confirmés. Le bouton « Tester les passerelles » relit
chaque passerelle (au plus une fois toutes les 5 s).

## Limites

- Entrées et relais sont lus à l’intervalle (10 s au moins) : un changement plus court peut passer
  inaperçu. Les notifications TCP et UDP des passerelles ne sont pas utilisées.
- Port série (IP2SL, Flex série) et commutateur HDMI non pris en charge.
- L’API RESTful HTTP du Flex n’est pas utilisée : le Flex parle aussi l’API TCP unifiée.

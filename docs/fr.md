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
- un code Pronto appris (`0000 006D 0000 0022 ...`), converti par l’intégration (les autres sortes de
  Pronto, `0100`, `5000`…, ne le sont pas).

Le format compressé de Global Caché (avec des lettres) n’est pas pris en charge. Les codes se trouvent
dans la base Control Tower de Global Caché ou s’apprennent avec l’outil iLearn.

Avant d’envoyer, l’intégration vérifie le code d’après les bornes du manuel : fréquence de 15 000 à
500 000 Hz (20 000 au moins pour un GC-100) ; 1 à 20 répétitions ; décalage impair, 383 au plus (255
sur un GC-100) ; durées par paires, de 50 000 au plus, chacune de 80 µs au moins (et de 4 au moins sur
Flex et Global Connect) ; 512 durées au plus ; 5 s d’émission au plus, répétitions comprises. Elle
relit ensuite l’identité de la passerelle et le mode du port : un port réglé en capteur n’émet rien. L’action renvoie `confirmed`
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
- un relâchement (de ce relais ou d’un autre de la passerelle) a été demandé avant le premier octet de
  l’impulsion : il passe devant ;
- la passerelle n’est pas encore créée dans Gladys, ou un autre modèle répond à son adresse ;
- le port n’est plus un relais simple de la passerelle ;
- le relais est lu fermé juste avant ;
- la passerelle est injoignable, répond de façon inattendue ou trop lentement (Gladys attend 5 s) ;
- 8 commandes attendent déjà pour cette passerelle ;
- l’intégration s’arrête (dès le début de l’arrêt).

Juste avant l’envoi, l’intégration relit sur la même connexion le modèle de la passerelle, ses modules
et l’état du relais, puis écrit dans `/data` le relâchement à venir. Le relâchement part après la durée
de l’impulsion, même si la passerelle n’a pas répondu à l’impulsion.

Sur un GC-100, qui n’accepte qu’une connexion à la fois, l’impulsion garde sa connexion pendant sa
durée et son relâchement part sur cette même connexion : une autre application ne peut pas la prendre
entre les deux. Les autres commandes vers ce GC-100 attendent la fin de l’impulsion (un relâchement,
lui, passe aussitôt sur la connexion gardée).

### Le relâchement

Le relâchement (ouvrir le contact) ne dépend ni de l’option, ni de la
configuration pas encore lue, ni d’une lecture ou d’une commande en cours ; il ne lui faut que l’adresse
de la passerelle, que porte l’appareil. Il passe devant tout : il annule
les impulsions de ce relais qui attendent, coupe tout de suite une lecture ou une commande qui n’a encore
rien écrit, et coupe une commande déjà partie si la passerelle n’a rien dit depuis 1 s. Il est confirmé par une lecture du relais faite après
lui.

Il n’échoue que si la passerelle ne répond pas, ou si l’arrêt de l’intégration dépasse 2 s. Il est
alors gardé dans `/data` et en mémoire, renvoyé sur une minuterie à lui (1 s, 2 s, 5 s, 10 s, 30 s,
puis chaque minute, jusqu’à confirmation), à chaque lecture réussie de la passerelle et à chaque
démarrage de l’intégration (avant même la lecture de la configuration) ; le statut le signale. Si
`/data` est illisible, il est gardé en mémoire seulement (et renvoyé de même) : un redémarrage le
perdrait, le statut le dit.

À l’arrêt de l’intégration, plus aucune impulsion ne part ; chaque relais tenu, en cours d’impulsion ou
dont le relâchement attend est relâché (2 s au plus). Un relâchement qui n’a pas pu partir reste dans
`/data` et part au démarrage suivant.

## Statut

L’écran de configuration montre, par passerelle, le modèle, le nombre de relais et d’entrées, la
dernière commande, et les relâchements pas encore confirmés. Le bouton « Tester les passerelles » relit
chaque passerelle (au plus une fois toutes les 5 s).

## Limites

- Entrées et relais sont lus à l’intervalle (10 s au moins) : un changement plus court peut passer
  inaperçu. Les notifications TCP et UDP des passerelles ne sont pas utilisées.
- Port série (IP2SL, Flex série) et commutateur HDMI non pris en charge.
- L’API RESTful HTTP du Flex n’est pas utilisée : le Flex parle aussi l’API TCP unifiée.

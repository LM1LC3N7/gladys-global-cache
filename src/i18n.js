// -----------------------------------------------------------------------------
// Every text shown to the user, in French and English. A text shown in the
// Configuration screen is a { en, fr } object; device and feature names follow
// the "Language of the names" option. No raw value typed by the user (an
// invalid address, an IR code) is ever shown back: it is only counted.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const t = (fr, en) => ({ fr, en });

const cut = (text) =>
  text.length > LIMITS.actionText ? `${text.slice(0, LIMITS.actionText - 1)}…` : text;

export const pick = (text, language) => text[language === 'en' ? 'en' : 'fr'];

export const T = {
  // Configuration.
  noHost: t(
    'Indiquez l’adresse IP d’au moins une passerelle Global Caché.',
    'Enter the IP address of at least one Global Caché gateway.',
  ),
  hostsInvalid: t(
    'Aucune adresse valable : indiquez des adresses IP séparées par des virgules (par ex. 192.168.1.70, 192.168.1.71).',
    'No valid address: enter IP addresses separated by commas (e.g. 192.168.1.70, 192.168.1.71).',
  ),
  tooManyHosts: t('8 passerelles au plus.', '8 gateways at most.'),
  ignored: (count) =>
    t(`${count} adresse(s) ignorée(s) : invalide(s)`, `${count} address(es) ignored: invalid`),
  configLoading: t('Configuration pas encore lue.', 'Configuration not read yet.'),
  configUnreadable: (ms) =>
    t(
      `Configuration illisible depuis Gladys, nouvel essai dans ${Math.round(ms / 1000)} s.`,
      `Configuration unreadable from Gladys, trying again in ${Math.round(ms / 1000)} s.`,
    ),
  dataUnreadable: t(
    '/data illisible : impulsions de relais refusées, nouvelle lecture toutes les 10 s',
    '/data unreadable: relay pulses refused, read again every 10 s',
  ),
  relaysOff: t(
    'Relais désactivés (option « Autoriser les relais » décochée)',
    'Relays disabled ("Allow the relays" option unchecked)',
  ),

  // Status of a gateway.
  ok: (key, model, relays, sensors) =>
    t(
      `${key} : ${model}, ${relays} relais, ${sensors} entrée(s)`,
      `${key}: ${model}, ${relays} relay(s), ${sensors} input(s)`,
    ),
  starting: (key) => t(`${key} : première lecture en cours`, `${key}: first reading under way`),
  down: (key) => t(`${key} : injoignable`, `${key}: unreachable`),
  answer: (key) =>
    t(
      `${key} : réponse inattendue (est-ce une passerelle Global Caché, port 4998 ?)`,
      `${key}: unexpected answer (is it a Global Caché gateway, port 4998?)`,
    ),
  other: (key, model, created) =>
    t(
      `${key} : ${model} répond à la place du ${created} créé dans Gladys ; commandes refusées, relancez une Découverte`,
      `${key}: ${model} answers instead of the ${created} created in Gladys; commands refused, run a Discovery again`,
    ),
  owed: (key, count) =>
    t(
      `${key} : ${count} relâchement(s) de relais pas encore confirmé(s), le relais peut être resté fermé`,
      `${key}: ${count} relay release(s) not confirmed yet, the relay may still be closed`,
    ),
  lastCommand: (text) => t(`dernière commande : ${text.fr}`, `last command: ${text.en}`),
  testNoHost: t('Aucune passerelle à tester.', 'No gateway to test.'),

  // Commands.
  unknownDevice: t('Appareil inconnu de l’intégration.', 'Device unknown to the integration.'),
  notButton: t('Cette fonction se lit seulement.', 'This feature is read only.'),
  badValue: t('Valeur inattendue pour un bouton.', 'Unexpected value for a button.'),
  notCreated: t(
    'Passerelle pas encore créée dans Gladys : ajoutez-la depuis la Découverte.',
    'Gateway not created in Gladys yet: add it from Discovery.',
  ),
  busy: t(
    'Trop de commandes en attente pour cette passerelle, rien envoyé.',
    'Too many commands waiting for this gateway, nothing sent.',
  ),
  dataNotKept: t(
    'Impulsion refusée, rien envoyé : /data n’a pas pu garder le relâchement à venir.',
    'Pulse refused, nothing sent: /data could not keep the coming release.',
  ),
  noTime: t(
    'Passerelle trop lente, rien envoyé (réessayez).',
    'Gateway too slow, nothing sent (try again).',
  ),
  relayHeld: t(
    'Relais encore fermé ou relâchement en attente : rien envoyé.',
    'Relay still closed or release pending: nothing sent.',
  ),
  relayClosed: t(
    'Le relais est lu fermé : impulsion refusée, rien envoyé.',
    'The relay reads closed: pulse refused, nothing sent.',
  ),
  notRelay: t(
    'Ce port n’est plus un relais simple (SPST) de la passerelle : rien envoyé, relancez une Découverte.',
    'This port is no longer a simple (SPST) relay of the gateway: nothing sent, run a Discovery again.',
  ),
  otherDevice: (model, created) =>
    t(
      `Une ${model} répond à la place de la ${created} créée : rien envoyé.`,
      `A ${model} answers instead of the ${created} created: nothing sent.`,
    ),
  releasedMeanwhile: t(
    'Relâchement demandé entre-temps : impulsion annulée, rien envoyé.',
    'Release asked meanwhile: pulse cancelled, nothing sent.',
  ),
  stopping: t('Intégration en cours d’arrêt, rien envoyé.', 'Integration stopping, nothing sent.'),
  unreachable: t('Passerelle injoignable, rien envoyé.', 'Gateway unreachable, nothing sent.'),
  unexpected: t(
    'Réponse inattendue de la passerelle, rien envoyé.',
    'Unexpected answer from the gateway, nothing sent.',
  ),
  pulseDone: t('Impulsion faite.', 'Pulse done.'),
  pulseUnconfirmed: t(
    'Impulsion envoyée, sans confirmation ; le relâchement suit.',
    'Pulse sent, without confirmation; the release follows.',
  ),
  deviceRefused: (code) =>
    t(`Refusé par la passerelle (erreur ${code}).`, `Refused by the gateway (error ${code}).`),
  released: t('Relais relâché.', 'Relay released.'),
  releaseUnconfirmed: t(
    'Relâchement envoyé sans confirmation : gardé dans /data et renvoyé aux prochaines lectures.',
    'Release sent without confirmation: kept in /data and sent again by the next readings.',
  ),
  releaseNotSent: t(
    'Relâchement pas encore envoyé (passerelle injoignable) : gardé dans /data et renvoyé aux prochaines lectures.',
    'Release not sent yet (gateway unreachable): kept in /data and sent again by the next readings.',
  ),

  // IR.
  irDone: t('Code infrarouge émis.', 'Infrared code sent.'),
  irUnconfirmed: t(
    'Code infrarouge envoyé, sans confirmation de fin d’émission.',
    'Infrared code sent, without confirmation of the end of the transmission.',
  ),
  irBusy: t(
    'Port infrarouge occupé par une autre émission : rien émis.',
    'Infrared port busy with another transmission: nothing sent.',
  ),
  notIrPort: t(
    'Ce connecteur n’est pas une sortie infrarouge de la passerelle (module:port, par ex. 1:1) : rien envoyé.',
    'This connector is not an infrared output of the gateway (module:port, e.g. 1:1): nothing sent.',
  ),
  irMode: (mode) =>
    t(
      `Le port est réglé en ${mode}, pas en sortie infrarouge : rien envoyé.`,
      `The port is set to ${mode}, not to infrared output: nothing sent.`,
    ),
  connectorMissing: t(
    'Indiquez le connecteur (module:port, par ex. 1:1).',
    'Enter the connector (module:port, e.g. 1:1).',
  ),
  connectorMismatch: t(
    'Le connecteur indiqué diffère de celui du code sendir : rien envoyé.',
    'The connector entered differs from the one of the sendir code: nothing sent.',
  ),
  ir: {
    empty: t('Code infrarouge vide.', 'Empty infrared code.'),
    tooLong: t('Code infrarouge trop long.', 'Infrared code too long.'),
    format: t(
      'Code infrarouge illisible : format Global Caché (sendir) ou Pronto attendu.',
      'Unreadable infrared code: Global Caché (sendir) or Pronto format expected.',
    ),
    compressed: t(
      'Format Global Caché compressé non pris en charge : utilisez le format non compressé.',
      'Compressed Global Caché format not supported: use the uncompressed format.',
    ),
    connector: t('Connecteur du code sendir invalide.', 'Invalid connector in the sendir code.'),
    pronto: t('Code Pronto incohérent.', 'Inconsistent Pronto code.'),
    frequency: t(
      'Fréquence hors de 15 000 à 500 000 Hz (20 000 au moins pour un GC-100).',
      'Frequency outside 15,000 to 500,000 Hz (20,000 at least for a GC-100).',
    ),
    repeat: t(
      `Nombre de répétitions hors de 1 à ${LIMITS.irRepeat}.`,
      `Repeat count outside 1 to ${LIMITS.irRepeat}.`,
    ),
    pairs: t(
      'Les durées doivent aller par paires (allumé, éteint).',
      'Durations must come in pairs (on, off).',
    ),
    pulse: t('Durée d’impulsion hors de 1 à 50 000.', 'Pulse count outside 1 to 50,000.'),
    offset: t(
      'Décalage de répétition invalide (impair, dans le code).',
      'Invalid repeat offset (odd, within the code).',
    ),
    tooLongToSend: t(
      `Émission de plus de ${LIMITS.irMaxMs / 1000} s (répétitions comprises) refusée.`,
      `Transmission longer than ${LIMITS.irMaxMs / 1000} s (repeats included) refused.`,
    ),
  },

  // Names of the features.
  relayState: { fr: (c) => `Relais ${c} (contact)`, en: (c) => `Relay ${c} (contact)` },
  relayPulse: { fr: (c) => `Relais ${c} : impulsion`, en: (c) => `Relay ${c}: pulse` },
  relayRelease: { fr: (c) => `Relais ${c} : relâcher`, en: (c) => `Relay ${c}: release` },
  sensor: { fr: (c) => `Entrée ${c}`, en: (c) => `Input ${c}` },
};

/** Several texts in one line, bounded. */
export function join(parts) {
  return {
    fr: cut(parts.map((p) => p.fr).join(' · ')),
    en: cut(parts.map((p) => p.en).join(' · ')),
  };
}

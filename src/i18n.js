// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  found: (lines) =>
    lines.length === 0
      ? both(
          'No Devialet speaker found. Type the IP address of each speaker in the configuration (the search cannot cross every network).',
          "Aucune enceinte Devialet trouvée. Saisissez l'adresse IP de chaque enceinte dans la configuration (la recherche ne traverse pas tous les réseaux).",
        )
      : both(
          `Found: ${list(lines)}. Create them from the Discovery tab.`,
          `Trouvées : ${list(lines)}. Créez-les depuis l'onglet Découverte.`,
        ),
  noSpeaker: both(
    'No speaker known yet: type their IP addresses in the configuration, or use "Find the speakers".',
    'Aucune enceinte connue : saisissez leurs adresses IP dans la configuration, ou utilisez « Chercher les enceintes ».',
  ),
  check: (lines) => ({
    en: lines.map((l) => l.en).join(' · '),
    fr: lines.map((l) => l.fr).join(' · '),
  }),
  checkLine: (label, reading) => {
    if (reading.on === true) {
      const volume = Number.isInteger(reading.volume) ? reading.volume : '?';
      return both(`${label}: answers, volume ${volume}`, `${label} : répond, volume ${volume}`);
    }
    if (reading.on === false) {
      return both(
        `${label}: no answer (standby, off or unreachable)`,
        `${label} : ne répond pas (veille, éteinte ou injoignable)`,
      );
    }
    return both(`${label}: unexpected answer`, `${label} : réponse inattendue`);
  },
  unreachable: (names) =>
    both(
      `Not answering (standby, off or unreachable), asked again at spaced intervals: ${list(names)}.`,
      `Ne répondent pas (veille, éteintes ou injoignables), redemandées à intervalles espacés : ${list(names)}.`,
    ),
  addressUnknown: (names) =>
    both(
      `Address unknown (another speaker answers at the old one): ${list(names)}. Run "Find the speakers" or type the new address; a search also runs by itself every 10 minutes.`,
      `Adresse inconnue (une autre enceinte répond à l'ancienne) : ${list(names)}. Lancez « Chercher les enceintes » ou saisissez la nouvelle adresse ; une recherche se lance aussi d'elle-même toutes les 10 minutes.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Devialet speaker answers yet at: ${list(addresses)}.`,
      `Aucune enceinte Devialet ne répond encore à : ${list(addresses)}.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved speaker list was unreadable and was reset; the speakers are found again from their addresses.',
    'La liste enregistrée des enceintes était illisible et a été réinitialisée ; les enceintes sont retrouvées par leurs adresses.',
  ),
};

# Adaptive Thermostat face à Versatile Thermostat

Comparaison établie contre le **code réellement implémenté** (vérifié module par module),
et non contre `docs/SPEC.md`. Référence amont : Versatile Thermostat 10.2.0.

## En un coup d'œil

| | VT | Nous |
|---|---|---|
| Types d'émetteur | 4 (`over_switch`, `over_climate`, `over_valve`, vanne directe) | **1** (`over_climate`, avec vanne directe) |
| Algorithme TPI | oui | oui |
| Auto-régulation PI | 5 modes + expert | 5 modes + expert |
| Détection d'ouverture | capteur + pente | capteur + pente |
| Présence, mouvement, presets | oui | oui |
| Chaudière centrale | oui | oui |
| Mode sécurité | oui | oui |
| Délestage par puissance | oui | **non** |
| Auto start/stop | oui | **non** |
| Types d'émetteur autres | oui | **non** |

## Ce qui est à parité

**Algorithme TPI.** Formule, coefficients (0,6 / 0,01), et surtout les seuils haut/bas tels qu'ils
sont vraiment chez VT — dépendants du **signe de la pente**, pas une hystérésis à verrou.
Interpolation de l'ouverture de vanne avec `min`, `max`, `opening_threshold` et `max_closing_degree`.

**Auto-régulation par offset.** Les cinq modes avec leurs constantes exactes, protection surchauffe
comprise, accumulation pondérée par le temps, et la suspension complète de la régulation quand aucun
capteur extérieur n'est lié — comportement VT que j'avais d'abord raté.

**Détection d'ouverture.** Les deux modes, exclusifs. Lissage de pente 0,2/0,8, minimum de quatre
points, rejet au-delà de 120 °C/h, deux délais distincts à l'ouverture et à la fermeture, action
configurable, bypass.

**Presets et présence.** Hors-gel, éco, confort, boost, manuel, Activité. Températures d'absence par
preset. Preset temporisé qui survit à un redémarrage. Mouvement avec ses deux temporisations,
disponible seulement si ses quatre réglages sont renseignés.

**Chaudière centrale et mode central.** Comptage en émetteurs, seuil, délai d'activation, keep-alive,
et les quatre modes centraux avec leur sémantique réelle : seul `stopped` arrête, `frost` et
`heat_only` continuent de réguler.

**Mode sécurité.** Capteur muet, seuil de déclenchement sur la dernière puissance connue (0,5 par
défaut), puissance de repli (0,1), désactivation en mode consigne — mêmes valeurs et même
raisonnement que VT, y compris le refus de secourir une pièce qui ne chauffait presque pas.

Deux différences, dans notre sens : la demande de chaleur est **maintenue** pendant la sécurité,
sans quoi la vanne s'ouvrirait sur un circuit froid et ne chaufferait rien ; et l'utilisateur est
**prévenu** — avertissement sur l'appareil, carte Flow « le capteur se tait » — là où VT compense
en silence. Secourir et signaler, pas l'un ou l'autre.

**Injection de la température de pièce dans la vanne.** Les deux modes de VT, `external` et
`calibration` — ce dernier incrémental, comme chez lui.

## Ce que nous faisons différemment, et pourquoi

**Le garde-fou de chaudière est asymétrique et VT n'en a pas.** Soixante secondes avant tout nouvel
allumage, extinction jamais retardée. VT documente explicitement l'absence de délai à l'extinction ;
nous ajoutons seulement l'anti-rebond à l'allumage, après une chaudière pulsée en production.

**Preset choisi et état effectif sont deux capabilities.** VT mêle les presets forcés (`away`,
`power`, `security`) aux presets choisissables. Un sélecteur Homey affiche toutes ses valeurs : les
séparer évite qu'un Flow force un état interne.

**Un seul émetteur par thermostat.** VT en accepte plusieurs, avec des listes de bornes par vanne.
Restreint volontairement en v1.

**Le mode expert est par appareil.** VT le configure globalement en YAML ; Homey n'a pas d'équivalent.

## Ce qui manque, par ordre d'importance

**Le délestage par puissance.** Aucune notion de puissance totale ni de puissance maximale, donc
aucune coupure des thermostats les plus proches de leur consigne quand l'installation sature.

**L'auto start/stop.** Pas d'extinction prédictive d'un équipement qui consomme en veille.

**Les autres types d'émetteur.** `over_switch` (radiateur électrique piloté par relais, avec cycles
on/off) et `over_valve` (vanne exposée en `number` sans entité climat) n'existent pas. L'architecture
les accueille sans refonte, mais ils ne sont pas écrits.

**Fonctions annexes de VT absentes :** apprentissage automatique des coefficients (Auto-TPI),
verrouillage par code PIN, détection d'anomalie de chauffe, réparation d'état incorrect,
recalibrage des vannes, auto-ventilation, mode climatisation, compteurs d'énergie.

## Ce que nous avons et que VT n'a pas

**Un point de diagnostic.** `GET /diagnostics` expose l'état du hub, celui du broker, et un tampon de
traces. Une app Homey installée par CLI n'a aucun log lisible ; c'est ce point qui a permis de
distinguer « le driver n'a rien envoyé » de « la vue n'a rien affiché » pendant la mise au point.

**L'édition des sources depuis les réglages de l'app**, avec détection des appareils disparus. Sur
Homey, un appareil Zigbee ré-appairé change d'identifiant : sans ce signalement, un thermostat
devient silencieux sans explication.

**La fraîcheur des mesures est un type, pas une convention.** Toute lecture porte son horodatage et
son caractère périmé, avec un seuil par nature de source. La régulation ne peut pas piloter une
chaudière sur une valeur morte par simple oubli.

**Résolution des sous-capabilities et des variantes de capteurs.** Une vanne expose
`target_temperature.local`, un détecteur mmWave `alarm_presence` plutôt qu'`alarm_motion` : la
liaison résout ce que l'appareil porte réellement.

## Verdict

Sur le **cœur de régulation**, la parité est réelle : mêmes formules, mêmes constantes, mêmes cas
limites, vérifiés contre le code Python amont et couverts par des tests.

Sur le **périmètre**, nous couvrons le cas d'usage principal de VT — un capteur, un émetteur, une
chaudière — et laissons de côté trois familles : la sécurité en cas de capteur muet, la gestion de
puissance, et les types d'émetteur autres que `over_climate`.

Le manque qui comptait — le **mode sécurité** — est comblé. Ce qui reste, le délestage par puissance
et l'auto start/stop, relève de la fonctionnalité et non du filet.

Vérifié sur l'installation le 2026-08-22 : la chaîne complète capteur → TPI → ouverture de vanne →
demande agrégée → relais de chaudière fonctionne de bout en bout, et l'installation revient au repos
quand la demande retombe. La réaction prend jusqu'à trente secondes, durée du battement de
l'ordonnanceur — c'est le prix d'un comptage des demandes fait sur des données du même instant.

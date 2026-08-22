# Plan d'implémentation — Versatile Thermostat pour Homey (v1)

Référence normative : `docs/SPEC.md`. Révision 2 — intègre la revue d'architecture et la décision
« cœur Homey + dorsale MQTT optionnelle » (SPEC §1.1).

## Principe directeur

**Le temps et la fraîcheur des données sont des invariants métier, pas des détails de plomberie.**
Une régulation thermique est une machine à états temporelle pilotée par des capteurs tiers non fiables.
Dès qu'on laisse le temps (`setInterval`, `setTimeout`) ou la fraîcheur (un `number` nu au lieu d'une
lecture horodatée) sortir du noyau, les décisions les plus critiques — quand commuter la chaudière,
faut-il encore croire cette température — migrent vers les fichiers Homey et deviennent intestables.

D'où trois règles structurelles :

1. **`lib/` est pur, `runtime/` parle à Homey**, et c'est le compilateur qui l'impose :
   `tsconfig.test.json` ne compile que `lib/` et `test/`. Un import de `homey` égaré dans `lib/`
   casse `npm test` sur-le-champ.
2. **Aucune minuterie dans le noyau.** Un réducteur qui doit être rappelé plus tard retourne
   `wakeUpAtMs`. L'app n'a qu'un seul timer, dans l'ordonnanceur.
3. **Une lecture de capteur n'est jamais un nombre nu** mais un `Reading<T> = {value, atMs, stale}`.
   C'est le type qui force à traiter le capteur muet, au lieu de le découvrir un jour de gel.

## Arborescence cible

```
homey-vtherm/
├─ .homeycompose/{app.json, capabilities/, flow/}
├─ app.mts                       registre des participants + ordonnanceur + hub
├─ lib/                          PUR — aucun import hors builtins Node
│  ├─ types.mts  constants.mts
│  ├─ tpi.mts  selfRegulation.mts  slope.mts
│  ├─ windowDetector.mts  presetResolver.mts  boilerAggregator.mts
│  ├─ step.mts                   le réducteur racine d'un VTherm
│  └─ stateLabel.mts             table de priorité ordonnée de `vtherm_state`
├─ runtime/                      COUPLÉ — seul endroit qui importe homey / homey-api / mqtt
│  ├─ hub.mts                    homey-api : connect(), bind, read, write dédupliqué
│  ├─ mqttBackend.mts            dorsale optionnelle Zigbee2MQTT (SPEC §1.1)
│  ├─ scheduler.mts              l'unique timer
│  ├─ emitter.mts                EmitterAdapter + EmitterGroup
│  └─ participants.mts           adhérence device Homey ↔ noyau
├─ drivers/{vtherm,central}/
├─ locales/{en,fr,nl}.json
└─ test/
```

Conventions reprises de `homey-scrypted` : TypeScript `.mts`, `module: NodeNext`, `strict`,
`@types/homey` = `homey-apps-sdk-v3-types`, scripts `typecheck` / `test` / `validate:publish`.

---

## Lot 0 — Fondations ✅ FAIT

`package.json`, `tsconfig`, `.homeycompose/app.json` (permission `homey:manager:api`,
`platforms: ["local"]`, catégorie `climate`), assets, séparation `lib/` / `runtime/`.

## Lot 1 — Réducteurs purs ⚠️ ÉCRIT, EN COURS DE CORRECTION

Une relecture du code source Python de Versatile Thermostat a établi que cinq règles avaient été mal
transposées : le terme externe de l'auto-régulation portait sur la consigne au lieu de la température
de pièce ; l'accumulation n'était pas pondérée par le temps ; le mode `slow` était noté sans protection
surchauffe alors qu'il l'a ; les seuils TPI avaient été pris pour une hystérésis alors qu'ils dépendent
du **signe de la pente** ; et la pente était calculée par un EMA à demi-vie au lieu du lissage 0,2/0,8
de VT. S'y ajoutait un garde-fou chaudière symétrique qui retardait l'extinction — dangereux, et
contraire au choix explicite de VT. Corrections en cours, spec à jour.

## Lot 1 — modules (état)

`tpi.mts`, `selfRegulation.mts`, `slope.mts`, `windowDetector.mts`, `presetResolver.mts`,
`boilerAggregator.mts` et leurs tests. Ces six modules deviennent des **réducteurs de tranche** :
ils gardent leur signature, mais opèrent sur des morceaux de l'état agrégé du lot 1bis.

## Lot 1bis — État agrégé et réducteur racine

Le point que la revue d'architecture a identifié comme le plus structurant.

```ts
// lib/types.mts
export interface Reading<T> { value: T; atMs: number; stale: boolean }

export interface VThermPersistentState {
  readonly version: 1;                 // sans quoi un champ manquant devient un NaN silencieux
  preset: Preset;
  manualSetpoint: number;
  timedPreset: TimedPreset | null;
  window: WindowState;                 // y compris l'état mémorisé { onoff, preset, setpoint }
  regulation: RegulationState;
  lastRunAtMs: number;                 // règle « arrêt > 1 h ⇒ RAZ de l'erreur cumulée »
}
export interface VThermVolatileState { slope: SlopeState; motion: MotionState; lastWrite: …; }
export interface VThermState { readonly persistent: …; readonly volatile: …; }

export function stepVTherm(state, inputs, config, nowMs): { outputs, nextState }
```

`outputs` porte `wakeUpAtMs` (qui remplace **toutes** les minuteries : délai fenêtre, délais de
mouvement, durée maximale de détection, expiration du preset temporisé) et `events[]` (les
déclencheurs Flow à émettre — décider que « la demande de chaleur a démarré » est une décision
métier, elle ne doit pas finir en `if (prev !== next)` dans un `device.mts`).

`migrate(raw)` retombe sur les valeurs par défaut devant tout ce qu'il ne reconnaît pas.
`lib/stateLabel.mts` expose la priorité de `vtherm_state` en table ordonnée : ajouter `safety` en
v1.1 sera l'insertion d'une ligne, pas la reprise d'une cascade de `if`.

**Tests** : scénarios de bout en bout — la fenêtre prime sur le preset, le mode central prime sur la
fenêtre, l'absence ne change pas le preset affiché, `onoff: false` ferme réellement la vanne.

## Lot 2 — Hub `homey-api` (le module le plus risqué de l'app)

`runtime/hub.mts`, seul importateur de `homey-api`. Contrat non négociable :

1. **`await api.devices.connect()` avant tout `getDevices()`**, et réaffirmé sur `reconnect`.
   Sans cet appel, les devices retournés ne sont pas mis en cache, `ManagerDevices.scheduleRefresh()`
   ne rejoue rien après une coupure, et les lectures se figent définitivement sans lever d'erreur.
   C'est la ligne la plus importante du projet.
2. `read(nowMs, freshnessMs)` **synchrone et qui ne lève jamais** — c'est ce qui permet à un tick de
   prendre un instantané cohérent de tous les VTherm. Les objets `Device` du cache sont mis à jour en
   place par le websocket : lire est un accès mémoire, le refetch réseau n'est que le filet.
3. `atMs` vient, dans l'ordre : de `capabilitiesObj[id].lastUpdated`, sinon de `lastChanged`
   (nullable — ne jamais s'y fier seul), sinon de l'instant où le listener a tiré. **Jamais `Date.now()` par défaut.**
4. Ré-abonnement : `DeviceCapability` s'auto-détruit en silence quand le device source disparaît
   (app tierce redémarrée, device ré-appairé). Il émet `'destroy'` avant de retirer ses listeners :
   c'est le point d'accroche pour re-résoudre le device et se ré-abonner.
5. `write(value, {minDelta, minIntervalMs, maxIntervalMs})` — la déduplication est une **fonction de
   correction**, pas une optimisation : le quota de l'API Athom se déclenche aussi en production.
   `maxIntervalMs` force la réécriture périodique exigée par la SPEC §5.3, que la seule déduplication
   rendrait impossible.
6. `device.available === false` ⇒ lecture inutilisable quel que soit son âge.
7. Seuil de fraîcheur **par nature de source**, jamais global : un capteur de température dans une
   pièce stable se tait légitimement vingt minutes, un contact de fenêtre des jours entiers.

**Comportements de repli, décidés maintenant :**

| Source morte | Comportement |
|---|---|
| Température de pièce | **Plus aucune demande de chaleur**, dernière sortie gelée, avertissement sur l'appareil. Continuer à calculer sur une température figée, c'est l'emballement. |
| Température extérieure | Terme `coef_ext` mis à 0. Non bloquant. |
| Contact de fenêtre | Traité **fermé** : un « ouvert » périmé gèlerait le logement. |
| Mouvement / présence | Repli sur présent + sans mouvement. |
| Émetteur indisponible | Aucune écriture, demande `unknown`, avertissement. |
| **Demandes inconnues** | **Chaudière OFF.** Jamais allumée sur de l'inconnu. |

Le type l'impose plutôt que la discipline :
`type Demand = {kind:'active', percent} | {kind:'inactive'} | {kind:'unknown'}`.
Avec un `boolean[]`, quelqu'un finira par défauter un manquant à `true`.

## Lot 2bis — Dorsale MQTT (SPEC §1.1)

`runtime/mqttBackend.mts` — client MQTT optionnel vers le broker Zigbee2MQTT, activé par les réglages
d'app (adresse, port, identifiants, `base_topic`). Publie `{"valve_opening_degree": n}` et
`{"external_temperature_input": t}` sur `<base_topic>/<friendly_name>/set`, exactement comme le fait
l'app Z2M en interne. Débloque le contrôle direct de vanne et la synchronisation du capteur de pièce.

Non configuré ⇒ ces deux fonctions sont indisponibles et l'app le dit. Le reste marche.
Un test de connexion doit être offert depuis la page de réglages : un broker mal renseigné doit se
voir immédiatement, pas se découvrir au premier jour de chauffe.

## Lot 3 — Ordonnanceur et registre

`runtime/scheduler.mts` : **un seul timer**, base 30 s, chaque participant annonçant son échéance
(`wakeUpAtMs` du noyau, borné par son `cycle_min`). Corps d'un tick :

```
1. hub.refresh(now)                       au plus un appel réseau
2. Promise.allSettled(vtherms.step(now))  isolation par device, timeout par lecture
3. collectDemands(results)                instantané cohérent
4. central.applyBoiler(demands, now)      UNE seule commande chaudière
```

C'est ce qui garantit que `nb_actifs` est compté sur des données du même instant. Avec cinq
intervalles indépendants, le garde-fou anti-pulsation de 60 s aurait servi en fonctionnement
**nominal** — un filet de sécurité utilisé comme mécanisme de conception.

`requestTick(reason)` **coalescé** est le chemin des recalculs hors cycle (changement de consigne,
de preset, nouvelle mesure, fenêtre, mouvement, mode central) : une rafale d'événements produit un
seul tick. C'est la parade structurelle au risque de pulsation, meilleure que le seul garde-fou.

Registre dans `app.mts` : les devices s'enregistrent auprès de l'App, jamais l'inverse.
L'ordre d'initialisation des drivers n'est pas garanti, donc aucune dépendance de driver à driver.
Absence de device central ⇒ `centralMode()` renvoie `'auto'` et l'étape 4 est simplement sautée :
ce n'est pas un cas particulier, c'est le défaut. Unicité du device central imposée **deux fois**,
au pairing et à l'exécution (le second se met indisponible) — une restauration de sauvegarde peut
en produire deux, et deux devices qui se disputent le même relais de chaudière, c'est précisément
la panne que le garde-fou existe pour empêcher.

`{lastBoilerCommand, lastSwitchAtMs}` est persisté dans le `store` du device central et restauré
en `onInit`, sinon un redémarrage d'app remet la garde de 60 s à zéro.

## Lot 4 — Émetteurs

`runtime/emitter.mts` : `EmitterAdapter` par appareil, `EmitterGroup` par VTherm (SPEC §2.1 autorise
1..n émetteurs). Décisions à graver :

- Le mode du groupe est `valve` **seulement si tous** les émetteurs disponibles le supportent.
  Un seul retardataire bascule tout le groupe en `setpoint` — mélanger deux lois de commande sur le
  même volume d'air, c'est deux régulateurs qui se battent.
- La demande de chaleur du groupe est active si **un** membre chauffe ; la batterie affichée est la
  **plus faible** des membres.
- La détection du mode lit `capabilitiesObj[id].setable`, pas la seule présence de l'identifiant,
  et se rejoue à chaque ré-abonnement — pas une fois au pairing.

## Lot 5 — Drivers `vtherm` et `central`

Pairing custom (capteur de pièce → émetteurs → sources optionnelles), réglages groupés et traduits,
capabilities standard et custom. Les devices ne contiennent que du câblage.
La configuration globale vit dans `homey.settings`, le device `central` n'en est qu'une **vue** :
supprimer le device ne doit pas effacer la configuration.

## Lot 6 — Cartes Flow

SPEC §10. Les déclencheurs viennent de `outputs.events`, jamais d'une comparaison ad hoc.

## Lot 7 — Localisation, assets, conformité App Store

**Après** les lots 5 et 6, pas en parallèle : les clés de traduction sont produites par les réglages
des drivers et les cartes Flow. Seuls les assets et le README étaient réellement parallélisables, et
ils sont faits.

- `locales/{en,fr,nl}.json`, vérifiés clé par clé — `validate --level publish` ne détecte pas une
  traduction manquante en profondeur.
- Description justifiant la permission `homey:manager:api` : l'app doit lire et piloter les appareils
  que l'utilisateur lui désigne, c'est sa raison d'être. Citer des apps publiées qui l'utilisent.
  **Plan B en cas de refus** : replier sur un mode « calcul + cartes Flow » où l'utilisateur câble
  lui-même les liaisons — l'app perd son principal argument mais reste publiable. À écrire avant de
  soumettre, pas après un refus.
- Avertissement sur le pilotage d'une chaudière réelle (SPEC §9.2).
- Nom : **Adaptive Thermostat**. L'identifiant technique `com.dataweavelabs.adaptivethermostat` sera renommé en
  `com.dataweavelabs.adaptivethermostat` à cette étape — il apparaît dans l'URL de la fiche du store.
- Attribution MIT à Versatile Thermostat : faite (`LICENSE`).
- `.homeychangelog.json` : fait.
- `tools/build-pair-views.mjs` : le pairing custom du lot 5 en aura besoin, comme dans `homey-scrypted`.

## Lot 8 — QA

`npm run typecheck` · `npm test` · `homey app validate --level publish`, jusqu'au vert.

**Lot 8bis — test de scénario, sans Homey** : trois VTherm pilotés sur quarante ticks avec un faux
hub, de faux émetteurs et une horloge manuelle, en assertionnant la **séquence** des commandes
chaudière. C'est le test qui attrape la classe de bug « chaudière pulsée », et il ne peut pas
attendre le matériel réel.

## Lot 9 — Validation sur matériel

Sur la Homey de production, quota API respecté (3-4 requêtes par manipulation, jamais un script de
quinze appels — il se fait couper au milieu et laisse l'installation dans un état intermédiaire).

**Ce lot touche le chauffage d'une maison habitée. Il a donc un plan de retour, écrit avant de commencer :**

1. **Sauvegarder** les 8 Flows Smart Heating (export JSON de chacun) avant de toucher à quoi que ce soit.
2. **Une seule pièce d'abord** — la Cuisine, qui est la seule chaîne vérifiée de bout en bout. Les quatre
   autres vannes restent sur Smart Heating pendant toute la durée de l'essai.
3. **Désactiver** les Flows Smart Heating de la Cuisine uniquement. Deux systèmes qui pilotent la même
   vanne se battent ; ce n'est pas un essai valable, c'est une panne.
4. **Critères de bascule arrière, décidés d'avance** : la pièce s'écarte de plus de 2 °C de la consigne
   pendant plus d'une heure ; la chaudière commute plus de 6 fois par heure ; la vanne ne répond plus ;
   le capteur de pièce n'est plus lu pendant plus d'une heure sans que l'app ne le signale.
5. **Restauration** : réactiver les Flows sauvegardés, retirer le device VTherm. Doit tenir en moins de
   cinq minutes, sans réflexion — l'écrire comme une procédure, pas comme une intention.
6. Les quatre autres pièces seulement après une journée de chauffe complète et concluante.

---

## Ordonnancement

```
Lot 0 ✅
 ├─ Lot 1 ✅ ─→ Lot 1bis ─┐
 ├─ Lot 2 ──┬─ Lot 2bis ──┼─→ Lot 3 ─→ Lot 4 ─→ Lot 5 ─→ Lot 6 ─→ Lot 8 ─→ Lot 9
 └─ Lot 7 ──┴─────────────┘                                  Lot 8bis ─┘
```

## Risques

| # | Risque | Parade |
|---|---|---|
| 1 | Websocket `homey-api` figé sans erreur, régulation sur données mortes | `devices.connect()` obligatoire ; lectures horodatées ; seuils de fraîcheur ; table de replis ; chaudière OFF sur inconnu |
| 2 | Chaudière pulsée | Tick unique coalescé + garde-fou 60 s persisté + test de séquence du lot 8bis |
| 3 | Quota API Athom, y compris en production | Écritures dédupliquées ; au plus un `getDevices()` par tick |
| 4 | Conflit avec les 8 Flows Smart Heating | Les désactiver avant le lot 9 |
| 5 | Refus Athom sur `homey:manager:api` | Le cœur fonctionne sans aucune autre app ; justification écrite au lot 7 |
| 6 | Broker MQTT mal configuré, découvert au premier jour de chauffe | Bouton de test de connexion dans les réglages |
| 7 | État persisté illisible après mise à jour ⇒ `NaN` propagé jusqu'à `setCapabilityValue` | Champ `version` et `migrate()` qui retombe sur les défauts |
| 8 | **Usure des piles** : 5 vannes × 4 propriétés toutes les 5 min ≈ 6 000 écritures Zigbee/jour | SPEC §5.5 : coalescence des pas, seuils de variation, rafraîchissement forcé arbitré par `maxInterval` |
| 9 | **Boucle d'écho** : l'app écrit `consigne + offset`, relit sa propre écriture, réapplique l'offset, et la vanne monte jusqu'à 35 °C | SPEC §5.4 : mémorisation de la dernière valeur envoyée, fenêtre d'ignorance de 30 s |
| 10 | Vanne laissée figée sur la dernière consigne après suppression du device ou désinstallation | SPEC §11.1 : remise en état sûr sur `onDeleted` et `onUninit` |
| 11 | Capteur de pièce sur pile qui meurt la nuit ⇒ régulation sur une valeur morte | Lectures horodatées, `stale` ⇒ **aucune demande de chaleur** et avertissement sur l'appareil (plus strict que le mode sécurité de VT, qui maintient 10 %) |
| 12 | Device Z2M ré-appairé ⇒ identifiant stocké orphelin | `onRepair` sur le driver `vtherm`, pour re-désigner une source sans refaire le pairing |
| 13 | Nom d'app prêtant à confusion avec un projet tiers | Tranché : **Adaptive Thermostat**, attribution MIT dans `LICENSE` |

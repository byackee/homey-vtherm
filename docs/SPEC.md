# Versatile Thermostat pour Homey — Cahier des charges (v1)

> Portage fidèle de l'intégration Home Assistant [Versatile Thermostat](https://github.com/jmcollin78/versatile_thermostat)
> (v10.2.0) en app Homey SDK v3. Ce document est la référence normative : toute divergence
> volontaire par rapport à VT est signalée par **[ÉCART]** et justifiée.

## 0. Décisions cadrantes

| Décision | Choix | Conséquence |
|---|---|---|
| Mode de pilotage | **Direct** — le VTherm connaît ses appareils sources et écrit dessus | Permission `homey:manager:api`, package `homey-api`, `platforms: ["local"]` uniquement (indisponible sur Homey Cloud) |
| Types VTherm en v1 | **`over_climate`** (avec et sans contrôle direct de vanne) + **configuration centrale / chaudière** | `over_switch` et `over_valve` hors périmètre v1, mais l'architecture doit les accueillir sans refonte |
| Périmètre v1 | Socle TPI + presets + fenêtre + chaudière, **plus** auto-régulation et présence/mouvement | Délestage, mode sécurité, auto start/stop : voir §12 (v1.1) |
| Destination | **App Store Athom** | `homey app validate --level publish` vert dès le départ, traductions `en`/`fr`/`nl`, assets, justification de la permission API |

## 1. Matériel de référence (installation de validation)

Relevé par websocket Zigbee2MQTT le 2026-08-21 sur l'installation cible :

- **5 × SONOFF TRVZB** (`Valve radiateur cuisine`, `salon`, `chb enfants`, `chb léon`, `sdb`).
  Propriétés inscriptibles pertinentes : `occupied_heating_setpoint` (4-35 °C, pas 0,5),
  `system_mode` (`off`/`auto`/`heat`), `valve_opening_degree` (0-100 %, pas 1),
  `valve_closing_degree` (0-100 %), `external_temperature_input` (0-99,9 °C, pas 0,1),
  `temperature_sensor_select` (`internal`/`external`/…), `local_temperature_calibration` (±12,7 °C).
  Lecture : `local_temperature`, `running_state` (`idle`/`heat`), `battery`.
- **2 × SONOFF SNZB-02** (`Detecteur_temp_cuisine`, `Detecteur temp chambre leon`) : `temperature`, `humidity`, `battery`.
- **1 relais chaudière** (`Chaudière`), commandé en `onoff`.
- Passerelle : app Homey **Zigbee2MQTT** (`com.gruijter.zigbee2mqtt`).

C'est précisément le cas que la doc VT désigne comme recommandé : `over_climate` **avec contrôle
direct de la vanne**, l'algorithme TPI calculant le pourcentage d'ouverture.

### 1.1 Ce que Homey expose réellement de la TRVZB — TRANCHÉ

Vérifié deux fois : dans le code de l'app `com.gruijter.zigbee2mqtt` (`src/capabilitymap.ts`, v3.3.0),
puis **sur l'appareil réel**, le 2026-08-21 — `Valve radiateur cuisine` n'expose que dix capabilities,
et le relevé ci-dessous est exhaustif.

| Propriété Z2M | Capability Homey | Pilotable par une app tierce |
|---|---|---|
| `occupied_heating_setpoint` | `target_temperature.local` | **oui** |
| `local_temperature` | `measure_temperature.local` | lecture |
| `system_mode` | `system_mode` | **oui** |
| `running_state` | `running_state` | lecture |
| `battery` | `measure_battery` | lecture |
| `open_window` | `alarm_generic.open_window` | lecture |
| `valve_opening_degree` | **aucune** | non |
| `valve_closing_degree` | **aucune** | non |
| `external_temperature_input` | **aucune** | non |
| `temperature_sensor_select` | **aucune** | non |

Relevé brut de la vanne de la cuisine, pour mémoire :

```
target_temperature.local              setable=True   22.5      maj 21:18
measure_temperature.local             setable=False  25.7      maj 20:24
system_mode                           setable=True   heat
running_state                         setable=False  idle
measure_battery                       setable=False  94
locked.child                          setable=True   True
alarm_generic.open_window             setable=False  False
target_temperature.frost_protection   setable=True   7
measure_linkquality                   setable=False  124
last_seen                             setable=False  None      maj None   <- inutilisable
```

Deux enseignements pour l'implémentation :

- **`last_seen` vaut `None` et n'a jamais été mis à jour.** La fraîcheur d'une source doit donc venir
  de `capabilitiesObj[...].lastUpdated`, jamais de cette capability qui en a pourtant l'air.
- `target_temperature.frost_protection` est inscriptible : le hors-gel peut être délégué à la vanne
  elle-même plutôt que simulé par une consigne basse. À exploiter au §11.1 (sortie propre).

Le relais de chaudière (`Chaudière`, également porté par l'app Z2M) expose `onoff` inscriptible —
c'est tout ce dont le §9.2 a besoin.

L'app Z2M reçoit ces quatre dernières propriétés et les journalise en « not mapped » : elles n'existent
pas côté Homey. La carte Flow `custom_payload_set` de cette app publie littéralement un JSON sur
`<base_topic>/<friendly_name>/set`, mais déclencher la carte Flow d'une autre app depuis du code n'est
pas une voie fiable (« permission denied » rapporté sur `runFlowCardAction`, non résolu).

**Décision : architecture à deux dorsales.**

- **Dorsale Homey (toujours active, aucune configuration).** Régulation par consigne décalée sur
  n'importe quel appareil Homey portant `target_temperature`. C'est le cœur de l'app, ce qui la rend
  universelle et publiable. Elle fonctionne seule, entièrement.
- **Dorsale MQTT (optionnelle, activée par réglage).** Si l'utilisateur renseigne l'accès à son broker
  Zigbee2MQTT, l'app publie elle-même sur `<base_topic>/<friendly_name>/set` et débloque le contrôle
  direct de l'ouverture de vanne (§5.1) et l'injection de la température de pièce (§5.3). Sans ce
  réglage, ces deux fonctions sont simplement indisponibles et l'app le dit clairement.

Conséquence pour l'App Store : la fonctionnalité de base ne dépend d'aucune autre app, ce qui satisfait
la règle Athom « an app's core functionality must always work standalone ». La dorsale MQTT est un
supplément, pas une béquille.

## 2. Modèle d'objets

### 2.1 Driver `vtherm` — un thermostat virtuel par pièce

`class: "thermostat"`. Créé par pairing custom. Ne correspond à aucun matériel.

**Sources liées au pairing** (stockées en `store`, modifiables ensuite en réglages) :

| Source | Obligatoire | Rôle |
|---|---|---|
| Capteur de température de pièce | oui | `measure_temperature` d'un device Homey quelconque |
| Émetteur sous-jacent | oui (**1 à 8**, voir §2.1bis) | device portant `target_temperature` (+ éventuellement l'ouverture de vanne), ou un `onoff` de classe chauffante |
| Capteur de température extérieure | non | alimente le terme `coef_ext` du TPI |
| Capteur d'ouverture (fenêtre/porte) | non | `alarm_contact` — mode capteur de la détection fenêtre |
| Capteur de mouvement | non | `alarm_motion` — preset Activité |
| Capteur de présence | non | `alarm_motion`/`onoff` global au logement |

### 2.1bis Groupe d'émetteurs — plusieurs têtes pour une pièce

Une pièce a souvent deux ou trois émetteurs : deux radiateurs sous deux fenêtres, un convecteur de
chaque côté d'un séjour traversant. Ils partagent une température, une consigne et un preset ; seul
le nombre de vannes change.

**Stockage.** `emitterIds` porte la liste ORDONNÉE, `emitterId` reste écrit et vaut toujours
`emitterIds[0]`. Cette redondance est délibérée dans les deux sens : un thermostat créé avant les
groupes n'a que `emitterId` et doit continuer de chauffer, et une version antérieure de l'app
relisant un `store` de groupe doit retrouver une tête plutôt que rien. Un rétrogradage dégrade, il
n'éteint pas.

**Homogénéité — imposée au choix.** Toutes les têtes doivent accepter une consigne, ou aucune.
`lib/step.mts` choisit une branche ENTIÈRE sur `emitterMode` : un groupe mixte n'a pas de
comportement correct à offrir, il en aurait un par tête. Le refus est prononcé au moment du choix,
pas découvert en hiver.

**Ce que le noyau voit.** Il continue de raisonner sur la pièce. Le nombre de têtes n'entre dans
`VThermInputs` que pour le découpage temporel, seule décision qui doive produire une commande
différente par tête.

**Déphasage (mode interrupteur).** Les têtes d'un groupe sont décalées de `1/N` de cycle. Trois
convecteurs à 30 % commandés ensemble tirent trois fois leur puissance pendant trois minutes puis
rien pendant sept ; décalés, ils délivrent exactement la même énergie sans jamais se superposer tant
que la demande reste sous `1/N`. L'ancrage du cycle reste commun : donner à chaque tête son propre
`cycleStartMs` les laisserait dériver jusqu'à se resynchroniser par hasard.

**Agrégations.** `readHeating` est un OU — la pièce est chauffée dès qu'une tête l'est, et c'est ce
qui décide de la demande envoyée à la chaudière. `readBattery` est un minimum : c'est la pire pile
qui décidera de la prochaine intervention. Le doute sur une écriture (`valveUnconfirmed`,
`switchUnconfirmed`) est un OU lui aussi — la demande passe `unknown` plutôt que de faire tourner
une chaudière sur un circuit dont on ne sait pas s'il consomme.

**Divergence.** Elle se lit TÊTE PAR TÊTE (`emitterHeatingHeads`). L'agrégat vaut `true` dès qu'une
tête chauffe ; le comparer à l'état commandé d'une autre ferait voir une divergence permanente sur
un groupe déphasé, c'est-à-dire une réécriture de tous les relais à chaque pas.

**Tête dont le mode a dérivé.** Un appareil ré-annoncé par Zigbee2MQTT peut revenir sans sa
consigne. Il est alors ÉCARTÉ des commandes tant qu'il n'est pas revenu — le garder ferait échouer
chaque écriture, et son doute rendrait la demande `unknown` pour toujours : la chaudière resterait
éteinte pour toute la pièce à cause d'une seule tête. La détection continue de le lire, c'est elle
qui le fait revenir, et la remise en état sûr de fin de vie le couvre lui aussi.

**Tuiles.** `vtherm_emitter_battery` et `vtherm_valve_open` sont déclarées dès qu'UNE tête les
justifie. Une tête ajoutée plus tard peut les faire apparaître — `addCapability` sur une capability
absente ne détruit aucun historique Insights. Elles ne sont jamais RETIRÉES : `removeCapability`
coûterait la courbe de tout un hiver pour gagner une tuile en moins.

**Borne à 8.** Chaque tête est un appareil de plus écrit à chaque pas, et le quota de l'API Athom se
déclenche en production. Au-delà, le groupe est refusé — jamais tronqué en silence.

### 2.2 Driver `central` — configuration centrale et chaudière

`class: "other"`, **instance unique** (le pairing refuse la seconde). Porte le mode central,
le pilotage de la chaudière, et les valeurs par défaut héritées par les VTherm.

### 2.3 Capabilities

Standard : `measure_temperature`, `target_temperature` (min 5, max 35, pas 0,5), `onoff`,
`measure_battery` (recopié de l'émetteur si disponible), `alarm_contact` (fenêtre), `alarm_motion`.

Custom (`.homeycompose/capabilities/`), toutes préfixées `vtherm_` :

| Id | Type | UI | Setable | Sens |
|---|---|---|---|---|
| `vtherm_preset` | enum | picker | oui | `frost` \| `eco` \| `comfort` \| `boost` \| `none` |
| `vtherm_state` | enum | sensor | non | État effectif : `idle` \| `heating` \| `window` \| `away` \| `activity` \| `safety` \| `power` \| `central` |
| `vtherm_power_percent` | number (%) | sensor | non | `on_percent` TPI × 100 — pourcentage de puissance du cycle |
| `vtherm_valve_open` | number (%) | sensor | non | Ouverture de vanne réellement commandée |
| `vtherm_regulated_setpoint` | number (°C) | sensor | non | Consigne réellement envoyée à l'émetteur (consigne + offset) |
| `vtherm_slope` | number (°C/h) | sensor | non | Pente de température lissée (EMA) |
| `vtherm_central_mode` | enum | picker | oui | *(device `central`)* `auto` \| `stopped` \| `heat_only` \| `frost` |
| `vtherm_boiler_active` | boolean | sensor | non | *(device `central`)* état de la demande chaudière |
| `vtherm_nb_active` | number | sensor | non | *(device `central`)* nombre d'émetteurs en demande |

**[ÉCART]** VT expose les presets forcés (`away`, `power`, `security`) comme des presets cachés du
même sélecteur. Sur Homey, un `picker` affiche toutes ses valeurs : on sépare donc le **preset choisi**
(`vtherm_preset`, inscriptible, seulement les 5 valeurs choisissables) de l'**état effectif**
(`vtherm_state`, lecture seule). C'est plus lisible et évite qu'un Flow force un état interne.

## 3. Boucle de régulation

Une boucle par device, `this.homey.setInterval`, période = réglage `cycle_min` (défaut **5 min**),
relancée dans `onInit` (les timers ne survivent pas à un redémarrage de l'app), nettoyée dans `onUninit`.

> **Corrigé après relecture du code source de VT.** Une première rédaction faisait sortir de la boucle
> dès que le mode central n'était pas `auto` et dès qu'une fenêtre était détectée. C'était faux dans les
> deux cas : `heat_only` et `frost` continuent de réguler chez VT, et les actions fenêtre `frost`/`eco`
> changent la consigne — encore faut-il ensuite réguler vers elle.

```
à chaque pas :
  1. mode central :
       stopped    → éteindre, sortir
       frost      → preset forcé = hors-gel, CONTINUER
       heat_only  → interdire le refroidissement, CONTINUER
       auto       → continuer
  2. si onoff = off               → consigne hors-gel, vanne à 0 %, aucune demande, sortir
  3. si fenêtre confirmée :
       turn_off / fan_only        → appliquer, sortir
       frost / eco                → consigne = température de l'action, SAUTER l'étape 4
  4. consigne = température du preset courant
     si absence détectée          → consigne = température "absence" du preset
     si preset = Activité         → consigne = motion_preset ou no_motion_preset selon le mouvement
  4. si régulation par vanne      → on_percent = TPI(consigne, T_pièce, T_ext)   [§4]
                                    ouverture = clamp(on_percent×100, min_open, max_open)
                                    écrire ouverture (et 100-ouverture en fermeture)
                                    écrire consigne brute sur l'émetteur (pour son affichage)
     sinon (offset de consigne)   → offset = régulation(consigne, T_pièce, T_ext)  [§5.2]
                                    écrire (consigne + offset) sur l'émetteur
  5. publier vtherm_state, vtherm_power_percent, vtherm_valve_open,
     vtherm_regulated_setpoint, vtherm_slope
  6. notifier le device central (demande de chaleur, puissance active)
```

Le recalcul est aussi déclenché **hors cycle** par : changement de consigne, changement de preset,
nouvelle mesure du capteur de pièce, changement d'état fenêtre/mouvement/présence, changement de mode central.

### 3.1 Arbitrages établis à l'implémentation

Sept points que le pseudo-code laissait ouverts et qui se sont révélés en écrivant le réducteur. Ils
font partie de la spécification au même titre que le reste.

1. **`onoff = false` passe avant le capteur muet.** Fermer une vanne ne demande aucune mesure. L'arrêt
   envoie la consigne hors-gel **et** ferme la vanne à **0 franc** — pas à `100 − max_closing_degree` :
   ce filet d'ouverture existe pour la régulation sous le seuil, pas pour un thermostat éteint.

2. **Un mode central non-`auto` neutralise l'action fenêtre**, pas seulement l'étiquette affichée.
   Conséquence assumée : sous `heat_only`, une fenêtre ouverte ne coupe plus la chauffe. C'est le
   sens d'un mode « central » — il prime.

3. **`fan_only` est traité comme `turn_off`** tant que le mode climatisation reste hors périmètre.

4. **`target_temperature` publie la consigne CHOISIE**, jamais celle envoyée à l'émetteur. C'est une
   capability inscriptible : y republier une valeur calculée ferait lutter l'app contre l'utilisateur
   à chaque pas. Ce qui part réellement vers l'émetteur vit dans `vtherm_regulated_setpoint`.

5. **Les deux modes ne se replient pas pareil sans capteur extérieur** : le TPI met simplement son
   terme externe à zéro et continue ; l'auto-régulation par offset est **suspendue en entier**
   (comportement VT). À dire, sinon c'est une surprise de mise en service.

6. **La remise à zéro de l'intégrale se juge en valeur absolue** — `|now − dernier pas| > 1 h`. Une
   horloge qui recule (heure d'été, resynchronisation NTP) rompt la continuité autant qu'un arrêt.

7. **Les consignes sont alignées sur le pas de 0,5 °C AVANT déduplication.** Sans cet ordre, 19,0001
   et 19,0002 comptent pour deux écritures distinctes vers un appareil qui les arrondit à la même valeur.

Et un mécanisme, plutôt qu'une règle : **une clé absente des sorties signifie « non calculable à ce
pas », donc capability inchangée.** C'est ainsi que la sortie se fige quand le capteur se tait —
publier un zéro de remplacement mentirait à l'utilisateur et fausserait durablement les Insights.

## 4. Algorithme TPI

Utilisé quand le VTherm régule lui-même, c'est-à-dire en **contrôle direct de vanne**.

```
on_percent = coef_int × (consigne − T_pièce) + coef_ext × (consigne − T_extérieure)
on_percent = clamp(on_percent, 0, 1)
```

| Réglage | Défaut | Plage | Note |
|---|---|---|---|
| `tpi_coef_int` | **0.6** | 0–2, pas 0,01 | Écart intérieur. Monte trop lentement → augmenter. Oscille → diminuer. |
| `tpi_coef_ext` | **0.01** | 0–1, pas 0,001 | Compense les pertes. Cible jamais atteinte → augmenter. Dépassée → diminuer. |
| `tpi_threshold_high` | 0 (désactivé) | 0–5 °C | Seuil de dépassement **quand la température monte** |
| `tpi_threshold_low` | 0 (désactivé) | 0–5 °C | Seuil de dépassement **quand la température descend**. Les deux vont par paire. |
| `min_opening_degree` | 0 % | 0–100 | Ouverture minimale quand la chauffe démarre |
| `max_opening_degree` | 100 % | 1–100 | Si `min >= max`, VT ramène `min` à `opening_threshold` plutôt que de refuser la saisie |
| `max_closing_degree` | 100 % | 0–100 | Sous le seuil, la vanne va à `100 − max_closing_degree`, et non à zéro |
| `opening_threshold` | 0 | **0–1** | En dessous, la vanne est considérée fermée. **Exprimé sur l'échelle de `on_percent`, donc une fraction, pas un pourcentage** — c'est ce qui fait que `on_percent = 1` rend exactement `max_opening_degree`. Saisir 20 au lieu de 0,2 laisserait la vanne fermée en permanence. Le réglage exposé à l'utilisateur est en %, converti à la lecture. |
| `regulation_threshold` | **3 %** | 0–20 | Variation minimale pour réécrire la vanne (recommandation VT pour TRVZB) |
| `cycle_min` | **5** min | 1–60 | Période de recalcul |

**Les seuils ne sont pas une hystérésis à verrou** — c'est l'erreur qu'une première rédaction avait
commise. Chez VT (`prop_algo_tpi.py`), ils dépendent du **signe de la pente** :

```
dépassement = T_pièce − consigne
si les deux seuils sont non nuls et que la pente est connue :
    si pente > 0 et dépassement > tpi_threshold_high  → on_percent = 0
    si pente < 0 et dépassement > tpi_threshold_low   → on_percent = 0
pente nulle ou inconnue → aucun effet
```

`slopePerHour` est donc une **entrée obligatoire** du calcul TPI, pas un raffinement. Il n'y a aucun
état de verrou à conserver entre deux pas.

Si aucune température extérieure n'est configurée, le terme `coef_ext` est nul (et non une valeur inventée).

### 4.1 De `on_percent` à l'ouverture de vanne

Ce n'est pas un simple bornage — VT interpole (`opening_degree_algorithm.py`) :

```
si on_percent >= opening_threshold et on_percent > 0 :
    pente = (max_opening_degree − min_opening_degree) / (1 − opening_threshold)
    ouverture = min_opening_degree + pente × (on_percent − opening_threshold)
sinon :
    ouverture = 100 − max_closing_degree
```

`max_closing_degree` (défaut **100**) manquait au tableau ci-dessus : sous le seuil, la vanne va à
`100 − max_closing_degree`, et non à zéro ni à `min_opening_degree`. Garde VT : si
`min_opening_degree >= max_opening_degree`, alors `min_opening_degree = opening_threshold`.

## 5. Auto-régulation `over_climate`

### 5.1 Contrôle direct de la vanne
**Nécessite la dorsale MQTT** (§1.1). Voir §4. La sortie TPI pilote `valve_opening_degree` ; `valve_closing_degree` reçoit `100 − ouverture`.
Une nouvelle valeur n'est écrite que si elle diffère de la précédente d'au moins `regulation_threshold`.

### 5.2 Offset de consigne (émetteurs sans vanne pilotable)

```
erreur          = consigne − T_pièce
dt              = intervalle depuis la DERNIÈRE INTÉGRATION, en unités de auto_regulation_period_min
                  (> 2.0 ⇒ 1.0 ; première intégration de la session ⇒ 1.0)

si dt < 1 :       la boucle N'INTÈGRE PAS. L'offset est recalculé depuis l'erreur cumulée mémorisée,
                  sans l'incrémenter ni la décharger, puis on s'arrête là.

erreur_cumulée  = clamp(erreur_cumulée + erreur × dt, ±accumulated_error_threshold)
offset          = kp × erreur + ki × erreur_cumulée + k_ext × (T_pièce − T_extérieure)
offset          = clamp(offset, ±offset_max)
consigne_envoyée = consigne + offset
```

Deux points sur lesquels une première rédaction s'était trompée, corrigés d'après `pi_algorithm.py` :

- Le terme externe porte sur **`T_pièce − T_extérieure`**, pas sur `consigne − T_extérieure`. Les deux
  ne coïncident que lorsque la pièce est déjà à la consigne ; l'écart grandit précisément quand on chauffe.
- L'accumulation est **pondérée par le temps écoulé**, pas une simple addition par pas. Sans ça, un pas
  déclenché hors cycle pèserait autant qu'un cycle complet et l'intégrale s'emballerait à chaque
  changement de consigne.

Deux autres, corrigés plus tard, après lecture de la source d'amont plutôt que de sa description :

- **`dt` se compte en périodes de RÉGULATION, pas en cycles TPI**, et son origine est la dernière
  intégration, pas le dernier pas du réducteur. Les deux unités ne coïncidaient que parce qu'elles
  valent 5 par défaut ; `cycle_min` est réglable de 1 à 60.
- **La boucle n'intègre qu'une fois par période** (`check_auto_regulation_period_min` chez VT). Notre
  ordonnanceur force un pas de TOUS les participants au moindre événement : sans cette porte, la boucle
  tournait jusqu'à deux cents fois par heure, `dt` tombait sous 0,5 dans 98 à 100 % des pas dès trois
  thermostats, et le plancher de la protection surchauffe y ramenait le diviseur à 1 — la protection ne
  protégeait plus rien. Les termes proportionnel et externe, eux, restent recalculés à chaque pas : ils
  ne dépendent que de la mesure courante, et les figer rendrait l'app sourde entre deux périodes.

**Sans capteur de température extérieure, VT saute entièrement l'auto-régulation** et envoie la consigne
nue. Le capteur extérieur étant optionnel (§2.1), c'est ce comportement qui est retenu : pas d'offset
inventé à partir d'une moitié de formule.

Modes préréglés, valeurs reprises telles quelles de VT :

| Mode | kp | ki | k_ext | offset_max | seuil accumulation | protection surchauffe |
|---|---|---|---|---|---|---|
| `none` | — | — | — | 0 | — | — |
| `slow` | 0.2 | 0.8/288 | 1/25 | 2.0 | 2.0 × 288 | oui |
| `light` | 0.2 | 0.05 | 0.05 | 1.5 | 10 | oui |
| `medium` | 0.3 | 0.05 | 0.1 | 2.0 | 20 | oui |
| `strong` | 0.4 | 0.08 | 0.0 | 5.0 | 50 | oui |

`protection surchauffe` : quand l'erreur et l'erreur cumulée sont de **signes opposés**
(`erreur × erreur_cumulée < 0`), l'erreur cumulée est divisée par `2 × max(dt, 0.5)`. Elle se rejoue donc
**à chaque pas tant que les deux se contredisent**, et non une seule fois à la traversée. Une première
rédaction disait « à chaque inversion de signe de l'erreur » : comparer l'erreur à celle du pas précédent
n'est pas la même chose, et se trompe deux fois — la décharge devenait ponctuelle, et un faux positif
coupait en deux une intégrale pourtant correctement signée. L'intégrale est sa propre mémoire ; aucun
état supplémentaire n'est nécessaire.

Le plancher `0,5` est un **garde-fou anti-amplification**, pas une atténuation voulue : sans lui, un pas
très court donnerait un diviseur inférieur à 1, donc une multiplication. Depuis que la boucle n'intègre
qu'une fois par période, ce plancher n'est plus atteignable par le chemin nominal.

Les **quatre** modes activent la protection (le tableau indiquait à tort « non » pour `slow`).
`auto_regulation_dtemp` (défaut 0,5 °C) : variation minimale d'offset pour réécrire la consigne.
`auto_regulation_period_min` (défaut 5 min) : **période de la boucle PI**, et unité de `dt`. Elle borne
aussi l'intervalle entre deux écritures.

**[ÉCART]** Le mode `expert` de VT (kp/ki/k_ext saisis à la main, global via `configuration.yaml`)
devient en v1 un cinquième choix `expert` dont les six paramètres sont éditables **par device** dans
les réglages avancés — Homey n'a pas d'équivalent de `configuration.yaml`.

### 5.3 Synchronisation du capteur de pièce vers l'émetteur

Reprend `feature-sync_device_temp` de VT et remplace le Flow 2 câblé à la main aujourd'hui.
**Nécessite la dorsale MQTT** (§1.1) : ni `external_temperature_input` ni `temperature_sensor_select`
n'existent comme capability Homey. Sans broker configuré, ce réglage est grisé et l'app avertit que
l'émetteur régulera sur son propre thermomètre. Deux modes, réglage par device :

- `off` — ne rien faire.
- `external` — écrire `temperature_sensor_select = external` une fois, puis pousser la température
  du capteur de pièce dans `external_temperature_input` à chaque nouvelle mesure. **Mode par défaut si
  l'émetteur le supporte** : sans lui la TRVZB régule sur son propre thermomètre, collé au radiateur.
- `calibration` — le calibrage est **incrémental**, pas absolu :
  `nouveau_calibrage = calibrage_courant + (T_pièce − local_temperature)`, borné à ±12,7 °C.
  Une première rédaction écrivait `T_pièce − local_temperature` en absolu, ce qui écrase l'offset déjà
  appliqué — et comme `local_temperature` reflète déjà cet offset, l'erreur se cumule à chaque écriture.

**[ÉCART] assumé** : VT n'écrit jamais `temperature_sensor_select`, jugeant le réglage trop dépendant du
matériel. Notre app l'écrit **une seule fois**, à la liaison de l'émetteur, parce que le TRVZB l'exige
pour prendre en compte `external_temperature_input` et que cibler un modèle précis nous le permet.

Les écritures de synchronisation partent **à chaque nouvelle mesure du capteur**, indépendamment du pas
de régulation, mais restent soumises à `auto_regulation_dtemp` et `auto_regulation_period_min` — voir
§5.5 : ces vannes sont sur piles.

### 5.3bis Quand la dorsale MQTT tombe en cours de journée

Le mode retombe sur la consigne, mais la vanne, elle, **reste physiquement figée sur sa dernière
ouverture**. Ramenée à 12 % par le TPI, elle ne pourra plus ouvrir au-delà quelle que soit la
consigne écrite ensuite : une pièce à 16 °C avec une consigne à 20 ne montera jamais.

À la perte de la dorsale, la vanne est donc **neutralisée** — ouverture 100 %, capteur interne,
calibrage à zéro — et un avertissement est posé sur l'appareil, retiré au retour. Une vanne grande
ouverte avec une consigne juste chauffe ; une vanne à 12 % ne chauffe pas. L'asymétrie penche
nettement d'un côté.

### 5.4 Anti-écho et changement manuel sur l'émetteur

En mode offset, l'app écrit `consigne + offset` sur l'émetteur ; Z2M renvoie cette valeur. Si l'app
relisait naïvement `target_temperature` comme une consigne utilisateur, elle recalculerait
`consigne + offset` par-dessus, à chaque pas, jusqu'à la butée de 35 °C de la vanne. **La suppression
d'écho n'est donc pas une commodité, c'est ce qui empêche un emballement.**

Règle : toute écriture mémorise `lastSentValue` et `lastSentAt`. Une valeur relue égale à
`lastSentValue`, ou reçue dans les 30 secondes qui suivent une écriture, est ignorée.

Comportement par défaut face à un réglage manuel sur la molette de la vanne : **ignoré, et écrasé au pas
suivant**. C'est le choix de VT, qui déconseille explicitement l'option inverse (« génère beaucoup
d'incompréhensions »). À dire dans la description de l'app, pas à découvrir à l'usage.

### 5.5 Économie d'écritures — ces vannes sont sur piles

Cinq TRVZB × (ouverture + fermeture + consigne + température externe) toutes les 5 minutes font près de
6 000 écritures Zigbee par jour, sur des appareils alimentés par piles. VT justifie explicitement ses
seuils par là. Trois règles :

1. **Coalescence** : les recalculs hors pas (§3) sont regroupés — au plus un pas toutes les
   **5 secondes**, quel que soit le nombre d'événements reçus. À ne pas confondre avec le battement
   de l'ordonnanceur (10 s), qui est la ronde vérifiant qui est dû : les avoir confondus faisait
   attendre une demi-minute qu'une consigne modifiée à la main produise un effet.
2. **Seuil de variation** : aucune écriture si l'écart avec la dernière valeur envoyée est inférieur à
   `regulation_threshold` (vanne) ou `auto_regulation_dtemp` (consigne).
3. **Rafraîchissement forcé** : une écriture périodique est malgré tout imposée par `maxInterval`, sans
   quoi `external_temperature_input` retomberait sur sa dernière valeur connue. Les règles 2 et 3 se
   contredisent en apparence ; c'est voulu, et c'est le paramètre `maxInterval` qui les arbitre.

## 6. Détection d'ouverture de fenêtre

Les deux modes sont **mutuellement exclusifs** par device (`window_mode` : `off` / `sensor` / `auto`).

### 6.1 Mode capteur
```
capteur → ouvert :  attendre window_delay (défaut 30 s)
                    si toujours ouvert : mémoriser (onoff, preset, consigne) puis appliquer l'action
capteur → fermé  :  attendre window_off_delay (défaut 30 s) — réglage DISTINCT chez VT,
                    et non un délai symétrique comme une première rédaction le supposait
                    si toujours fermé : restaurer l'état mémorisé
```

### 6.2 Mode auto (détection par chute de température)
Pente exposée en `vtherm_slope`, calculée comme chez VT (`open_window_algorithm.py`) :

```
pente = arrondi(0,2 × pente_précédente + 0,8 × pente_instantanée, 2)
```

Une première rédaction avait confondu ce lissage avec les paramètres `short_ema_params`
(`max_alpha` 0,5 ; `halflife` 300 s) qui, chez VT, lissent une **température** et non une pente.

Trois gardes indispensables, absentes de cette première rédaction :
- **au moins 4 points** de mesure avant toute détection ;
- toute pente supérieure à **120 °C/h** en valeur absolue est rejetée comme aberrante ;
- si la dernière mesure date de plus de 30 minutes, un point fictif est injecté pour éviter qu'une
  longue absence de données ne produise une pente délirante au retour du capteur ;
- un horodatage non croissant ne produit aucune dérivée, mais **reprend la référence**. L'horodatage
  vient du capteur, pas de l'horloge de l'app, et n'a pas de plafond : une passerelle qui hoquette
  suffisait à poser un `lastMs` dans le futur, et toute lecture correctement datée ensuite retombait
  dans la même branche. La pente restait figée pour la durée de vie du processus, en silence — alors
  qu'elle arbitre les seuils TPI (§4) et pilote entièrement la détection d'ouverture en mode auto.

| Réglage | Défaut |
|---|---|
| `window_auto_open_threshold` | **3 °C/h** de chute |
| `window_auto_close_threshold` | **0 °C/h** |
| `window_auto_max_duration` | **30 min** — au-delà, restauration même si la chute continue |

**[ÉCART] — la restauration DÉSARME la détection jusqu'au rétablissement de la pente.** Restaurer sans
désarmer ne restaure rien : couper le chauffage une demi-heure garantit que la pièce descend encore, donc
que le signal d'ouverture est toujours vrai à la levée. La détection se rouvrait au délai de confirmation
suivant — trente secondes de chauffe par demi-heure — et la pièce n'atteignait jamais l'équilibre qui
aurait permis d'en sortir. Le désarmement est levé au premier signal de fermeture, c'est-à-dire dès que
la pièce cesse de se refroidir, et il est persisté : une mise à jour d'app ne doit pas relancer la boucle.

### 6.2bis Le capteur qui se tait

**[ÉCART] — en mode capteur, une lecture ABSENTE vaut fin de détection.** Le signal de fermeture est
`sensorOpen !== true`, jamais `=== false`. Un contact peut cesser de répondre — appareil ré-appairé sous
un nouvel identifiant, sorti du cache de l'API, valeur non interprétable — et vaut alors `null`. Avec
`=== false`, ni l'ouverture ni la fermeture n'étaient vraies, et la phase `open` n'avait plus aucune
sortie : la fermeture forcée sur durée maximale ne vaut qu'en mode auto. Chauffage coupé, vanne fermée,
aucun avertissement, et l'état persisté survivait au redémarrage. Le seuil de fraîcheur de sept jours de
ce capteur portait déjà l'intention — « un "ouvert" périmé gèlerait le logement » — sans que la machine à
états l'honore. On ne confirme une fenêtre ouverte que sur un capteur qui l'affirme.

### 6.3 Action fenêtre
`window_action` : `turn_off` (défaut) \| `frost` \| `eco` \| `fan_only`.
Conformément à VT, les actions `frost`/`eco` changent la **consigne** sans changer le preset affiché ;
c'est `vtherm_state` qui vaut alors `window`.

Une action Flow `Ignorer la fenêtre` (bypass) permet de continuer à chauffer malgré l'ouverture,
équivalent du service `set_window_bypass`.

## 7. Présence et mouvement

**Présence** (globale au logement) : si le capteur indique l'absence, chaque preset utilise sa
température « absence » dédiée (`eco_away`, `comfort_away`, `boost_away`). Bascule immédiate,
sans changer le preset affiché ; `vtherm_state` vaut `away`.

**Mouvement** (local à la pièce) : disponible **uniquement si les quatre réglages sont renseignés**
(capteur, `motion_delay`, `motion_off_delay`, presets mouvement/sans-mouvement), conformément à VT.
S'active en sélectionnant le preset `activity`.

```
mouvement détecté  : confirmé après motion_delay (défaut 30 s)      → consigne = motion_preset
plus de mouvement  : confirmé après motion_off_delay (défaut 300 s) → consigne = no_motion_preset
```

## 8. Presets

Températures par défaut : hors-gel **7 °C**, éco **17 °C**, confort **19 °C**, boost **21 °C**.
Températures « absence » par défaut : éco 17, confort 17, boost 17.
`none` = consigne manuelle libre, aucun preset appliqué.

**Preset temporisé** (`set_timed_preset` de VT) : action Flow « Appliquer le preset X pendant N minutes »
(1–1440), retour automatique au preset précédent à l'échéance. L'échéance doit survivre à un redémarrage
de l'app (persistée en `store`, réarmée dans `onInit`).

## 9. Configuration centrale et chaudière

### 9.1 Mode central
`vtherm_central_mode` sur le device `central` : `auto` (défaut) \| `stopped` \| `heat_only` \| `frost`.
Chaque VTherm a un réglage `use_central_mode` (défaut : activé) qui décide s'il obéit.

### 9.2 Chaudière
Le device `central` reçoit au pairing le device chaudière à commander (capability `onoff`).

```
nb_actifs = nombre d'émetteurs en demande parmi les VTherm marqués "commande la chaudière"
  — régulation par vanne : actif si ouverture > opening_threshold
  — offset de consigne   : actif si l'émetteur est réellement en chauffe (running_state / onoff)

si nb_actifs >= boiler_threshold (défaut 1) :
    attendre boiler_activation_delay (défaut 0 s), puis chaudière ← ON
sinon :
    chaudière ← OFF immédiatement, sans délai
```

Un `boiler_keepalive` (défaut 0 = désactivé) réémet périodiquement l'ordre d'activation.

**[ÉCART] — garde-fou anti-pulsation, ASYMÉTRIQUE.** L'installation cible a déjà connu une chaudière
pulsée ON/OFF en moins d'une seconde à cause de deux Flows opposés sur le même événement. L'app impose
donc un délai minimal de **60 s avant tout nouvel ALLUMAGE**.

**L'extinction n'est jamais retardée.** Une première rédaction rendait le garde-fou symétrique — c'était
dangereux, et ça réintroduisait exactement le risque décrit par l'avertissement ci-dessous. VT documente
le choix : « Il n'y a pas de délai pour l'extinction de la chaudière. C'est volontaire pour vous éviter
de laisser tourner la chaudière alors que toutes les vannes sont fermées. » Le vrai anti-rebond porte
sur l'allumage, jamais sur la coupure.

Chaque commutation est journalisée. Le couple `{dernière commande, instant de la dernière commutation}`
est persisté : sans lui, un redémarrage de l'app remettrait le garde-fou à zéro.

**[ÉCART] — réaffirmation sur divergence.** L'ordre n'étant émis que sur CHANGEMENT, et `boiler_keepalive`
valant zéro par défaut, un ordre avalé en route n'était jamais réémis : trame Zigbee perdue, prise revenue
sur son `power_on_behavior` après une micro-coupure, quota d'API atteint pendant une rafale, bascule à la
main — et le modèle disait ALLUMÉE pendant que la maison restait froide, sans erreur ni trace, jusqu'au
prochain vrai changement de demande. L'état réel du relais est donc relu à chaque pas et remis en accord
avec ce qui a été commandé. Une correction n'est pas une commutation : elle ne repousse pas le garde-fou
et ne déclenche aucune carte Flow.

L'asymétrie vaut ici aussi, avec sa condition exacte. Corriger vers l'allumage attend le garde-fou.
Corriger vers l'arrêt ne l'attend pas, mais seulement quand **rien** ne demande de chaleur : couper un
relais resté allumé pendant l'attente qui précède un allumage fabriquerait le court-cycle que la
correction prétend éviter.

Et une extinction **imposée** à un relais observé allumé arme le garde-fou, alors même qu'elle ne change
pas l'état commandé. Elle ne touche pas l'instant de la dernière commutation — ce n'en est pas une pour
l'app — mais elle a arrêté un brûleur qui tournait, et le prochain allumage lui doit l'attente comme à
n'importe quelle autre extinction. La réaffirmation de démarrage compte pour la même raison, et c'est le
cas le plus exposé : sur un état neuf, l'instant de dernière commutation est nul, ce qui exempte du
garde-fou. Cette marque est persistée : sans elle, un redémarrage dans la minute rallumerait aussitôt. Les retentatives sont espacées de 30 s — un relais en panne peut réannoncer
son état en boucle, et chaque annonce vaudrait un appel d'API. La lecture ignore l'ÂGE : un relais qui ne
bascule pas ne réémet rien pendant des heures, et c'est précisément ce régime que la correction doit
voir ; seule l'indisponibilité de l'appareil la disqualifie.

L'avertissement de VT s'applique : piloter une chaudière réelle peut créer une surpression si tous les
robinets se ferment. La description de l'app et le réglage doivent le rappeler.

## 10. Cartes Flow

**Déclencheurs** : preset changé · état effectif changé (`vtherm_state`) · fenêtre ouverte/fermée
détectée · demande de chaleur démarrée/arrêtée · chaudière activée/désactivée · mode central changé ·
mode sécurité entré/sorti · pourcentage de puissance changé.

**Conditions** : preset est … · fenêtre est ouverte · quelqu'un est présent · le VTherm demande de la chaleur ·
la chaudière est active · le mode central est …

**Actions** : régler le preset · régler le preset pendant N minutes · annuler le preset temporisé ·
régler la consigne · allumer/éteindre · régler le mode central · ignorer la fenêtre (bypass) ·
régler les coefficients TPI (équivalent `set_tpi_parameters`) · forcer l'état de présence.

Homey ne fabrique de cartes `_changed` automatiques que pour les capabilities dont l'identifiant
porte un préfixe SYSTÈME (`measure_`, `meter_`, `alarm_`…). Aucune des nôtres n'en porte : toute
carte que nous voulons offrir doit être déclarée, et déclenchée explicitement par le code.

## 11. Persistance

| Donnée | Support |
|---|---|
| Sources liées (ids des devices) | `store` du device |
| Réglages (coefficients, seuils, températures de preset) | `settings` du device |
| Preset courant, consigne manuelle, état mémorisé fenêtre | `store` |
| Échéance d'un preset temporisé | `store`, réarmé dans `onInit` |
| Erreur cumulée de l'auto-régulation | `store`, remise à zéro si l'app a été arrêtée > 1 h |
| Mode central, seuils chaudière | `settings` du device `central` |

### 11.1 Sortie propre

À la suppression d'un VTherm (`onDeleted`) et à l'arrêt de l'app (`onUninit`), l'émetteur est remis dans
un état sûr et prévisible : `system_mode` à `auto` et consigne = **consigne utilisateur brute, sans
offset**. Sans ça, la vanne resterait figée sur la dernière valeur écrite par une app qui ne la pilote
plus — une consigne à 24 °C dans une pièce vide, sans personne pour la corriger.

`onUninit` n'étant pas garanti d'être appelé lors d'une désinstallation, la description de l'app doit
indiquer de supprimer les appareils avant de désinstaller.

## 12. Hors périmètre v1 (à cadrer pour la v1.1)

Le **mode sécurité** a finalement été implémenté (voir `lib/safety.mts`) : le laisser de côté
revenait à accepter qu'une pile morte laisse une pièce sans chauffage une nuit d'hiver, ce qui n'est
pas une fonctionnalité manquante mais un filet absent.

Il a été étendu après revue, parce qu'une première version ne couvrait pas le cas qui compte :

- **En pilotage par vanne**, il force une puissance minimale (10 % par défaut) et **maintient la
  demande de chaleur** — sans quoi la vanne s'ouvrirait sur un circuit froid et ne chaufferait rien.
- **En pilotage par consigne**, il force une **consigne de secours** plutôt qu'une puissance : une
  puissance n'a aucun sens sur un émetteur qu'on pilote par consigne. Réservé d'abord au mode
  vanne, il était inerte dans la configuration sans broker MQTT — c'est-à-dire dans le cas
  majoritaire, et exactement la panne qu'il devait couvrir.
- **En pilotage par interrupteur**, il ne s'applique pas : le relais est **coupé**. Un convecteur a
  sa propre source d'énergie ; le geler dans son dernier état le laisserait chauffer sans limite et
  sans personne pour l'arrêter. C'est l'inverse d'une vanne, qui est passive.
- Une **liaison orpheline** — capteur ré-appairé, donc identifiant obsolète — compte comme un
  capteur muet, pas comme une absence de capteur.
- Durée maximale de **24 h**. Au-delà, la sécurité abandonne : une chaudière qui tourne des jours
  sur un capteur mort est un risque plus grand que le gel qu'on cherchait à éviter.

Restent hors v1, sans que l'architecture les rende coûteux : **délestage par puissance**, **auto start/stop prédictif**,
**détection d'anomalie de chauffe**, **réparation d'état incorrect**, **Auto-TPI** (apprentissage
des coefficients), **verrouillage par PIN**, **types `over_switch` et `over_valve`**,
**mode climatisation** (`ac_mode`), **compteurs d'énergie**.

`vtherm_state` prévoit déjà les valeurs `safety` et `power` pour ne pas casser l'UI à l'ajout.

## 13. Critères d'acceptation de la v1

1. `npm run typecheck` et `homey app validate --level publish` passent sans erreur ni avertissement.
2. Tests unitaires (`node --test`) couvrant, sans Homey : TPI (y compris seuils haut/bas et bornage),
   offset de consigne des 4 modes préréglés (y compris protection surchauffe et bornage de l'accumulation),
   EMA de pente, machine à états fenêtre (capteur et auto), arbitrage preset/absence/mouvement,
   comptage chaudière et garde-fou de durée minimale.
3. L'app s'installe sur la Homey cible, un VTherm « Cuisine » se crée par pairing en choisissant
   `Detecteur_temp_cuisine` et `Valve radiateur cuisine`.
4. Une consigne réglée dans l'app Homey se retrouve sur la valve, avec l'offset ou l'ouverture attendus.
5. L'ouverture de la fenêtre cuisine coupe la chauffe après le délai, la fermeture la restaure.
6. La chaudière suit la demande agrégée et ne commute jamais deux fois en moins de 60 s.
7. Les trois locales `en`/`fr`/`nl` sont complètes.

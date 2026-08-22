# `test-runtime/` — la couche que `lib/` ne couvre pas

`test/` ne compile que `lib/`, volontairement : c'est ce qui garantit la pureté du cœur. Mais la
conséquence est restée invisible longtemps — **`runtime/` et `drivers/` n'étaient couverts par
aucun test**, et c'est exactement là que vivaient tous les défauts graves trouvés en revue :
une écriture avalée en silence, une chaudière jamais recommandée, une vanne figée après une
coupure de dorsale, une course entre l'arrêt de l'app et un tick en vol.

Aucun de ces défauts n'était détectable depuis `lib/`. Le cœur calculait juste ; c'est le câblage
qui mentait.

## Ce qui est testable, et comment

| Module | Import de `homey` | Approche |
|---|---|---|
| `runtime/scheduler.mts` | type seulement | direct, avec une fausse instance Homey |
| `runtime/emitter.mts` | type seulement | direct, avec un faux hub |
| `runtime/participants.mts` | type seulement | direct, avec un faux hôte de device |
| `runtime/valveBackend.mts` | aucun | direct |
| `runtime/hub.mts` | `homey-api` (importable) | direct, sans jamais se connecter |
| `runtime/mqttBackend.mts` | `mqtt` (importable) | direct, sans broker |
| `drivers/**` | **valeur** | `mock.module('homey', …)` |
| `app.mts` | **valeur** | `mock.module('homey', …)` + `mock.module('homey-api', …)` |

Le dernier cas mérite une explication : le paquet npm `homey` n'est **pas** la bibliothèque du SDK,
c'est l'outil en ligne de commande. L'importer dans un test exécute le CLI et affiche son aide.
D'où la substitution de module, qui exige `--experimental-test-module-mocks`.

## La règle de cette suite

**Assertionner la conséquence PHYSIQUE, jamais le mécanisme.** Un test existant affirmait
correctement qu'aucune écriture ne partait, et laissait pourtant passer un convecteur allumé
vingt-quatre heures. On écrit « le relais est coupé », pas « la fonction a rendu `null` ».

Corollaire : chaque fichier dit en tête QUELLES PANNES il empêche de revenir, et chaque test dit
laquelle. Un test dont on ne sait pas nommer la panne ne défend rien.

## Les fichiers

| Fichier | Panne principale gardée |
|---|---|
| `hub.test.mts` | l'écriture avalée : `false` ne doit signifier QUE la déduplication |
| `centralParticipant.test.mts` | la chaudière jamais recommandée après un ordre perdu au démarrage |
| `participants.test.mts` | le convecteur figé sur une mesure morte, le relais dévié jamais rallumé, la vanne figée après une coupure de dorsale, deux pas concurrents |
| `emitter.test.mts` | la consigne écrite dans le vide, l'emballement par écho, la sortie qui laisse un convecteur allumé |
| `scheduler.test.mts` | la rafale qui fait pulser la chaudière, l'échéance `NaN` qui arrête tout le logement, l'arrêt qui n'attend pas le pas en vol |
| `app.test.mts` | la dorsale perdue en cours de journée sans transition détectée ; l'ordre de `onUninit` |
| `drivers.test.mts` | la liste d'émetteurs devenue annuaire, la boucle de régulation sur soi-même, la capability déclarée à tort |

`fixtures.mts` porte le seul jeu de réglages de référence ; `fakes/` les doublures.

## Le temps est manuel

`FakeHomey` n'arme aucune vraie minuterie : `advance(ms)` fait avancer l'horloge et exécute ce qui
devient dû. Aucun test n'attend réellement. `FakeHomey.flush()` rend quelques tours de microtâches ;
`FakeHomey.settle()` laisse s'écouler tout ce qui est déjà prêt, ce qu'exige un cycle complet de
l'app.

Une exception connue : l'ordonnanceur construit par `app.mts` lit l'horloge réelle — elle ne lui est
pas injectable depuis l'app. Ses *minuteries* restent celles de `FakeHomey`, donc rien n'attend ;
mais les lectures de capteurs y sont datées de `Date.now()`, faute de quoi elles paraîtraient
périmées de cinquante ans.

## Lancer

```sh
npm run test:runtime   # cette suite
npm test               # le cœur pur
npm run test:all       # les deux
```

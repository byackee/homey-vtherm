# `lib/` — cœur pur

**Invariant, imposé par le compilateur :** aucun fichier de ce répertoire n'importe `homey`,
`homey-api`, ni quoi que ce soit hors des modules natifs de Node. `tsconfig.test.json` ne compile
que `lib/` et `test/` — un import de Homey qui s'égare ici casse `npm test` immédiatement.

Les fonctions sont pures : elles reçoivent un état, retournent le suivant, ne lisent jamais l'horloge
(`nowMs` est toujours un paramètre) et n'arment aucune minuterie. Un réducteur qui a besoin d'être
rappelé plus tard le dit en retournant `wakeUpAtMs` ; c'est l'ordonnanceur de `runtime/` qui arme
le seul timer de l'app.

Le code qui parle à Homey vit dans `runtime/`.

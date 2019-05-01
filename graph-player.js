module.exports = function (RED) {
    function GraphPlayerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', (msg) => node.send(NR_switch(msg, node)));
    }
    RED.nodes.registerType("graph-player", GraphPlayerNode);
}

function NR_switch(msg, node) {
    // Néhány globális
    var CTX = node.context();

    var DATA = CTX.get("data") || {
        "vertexList": [],
        "edgeList": [],
        "robotList": [],
        "busyRobots": [],
        "doneList": [],
        "commandList": {},
        "highestNumber": 0
    };
    var MONITOR = CTX.get("monitor") || {};
    var FLAGS = CTX.get("flagses") || { "SETUP": false, "IN_PROCESS": false };

    var REPLY = null;

    // TFH a felhasználó jóindulatú:
    //     * A node pontosan akkor kapott gráfot, hogyha van annak a payloadnak graphID property-je
    //     * A node pontosan akkor kapott reset parancsot, hogyha a payloadnak van reset tulajdonsága
    //     * A node pontosan akkor kapott start parancsot, hogyha a payloadnak van start tulajdonsága
    //
    if (msg.payload.hasOwnProperty("reset")) {
        // A kritikus és használt dolgok alaphelyzetbe állítása
        /*node.error("Data out", JSON.stringify(FLAGS));
        node.error("Data out", JSON.stringify(DATA));
        node.error("Data out", JSON.stringify(MONITOR));*/

        FLAGS.IN_PROCESS = false;
        FLAGS.SETUP = false;
        DATA = undefined;
        MONITOR = undefined;

        /*node.error("Data out", JSON.stringify(FLAGS));
        node.error("Data out", JSON.stringify(DATA));
        node.error("Data out", JSON.stringify(MONITOR));*/
        node.status({ text: "Resetted" });

    } else if (msg.payload.hasOwnProperty("graphID")) { // Tehát ha gráf jött
        if (FLAGS.IN_PROCESS) {
            // Egyenlõre legyen így, külön ágon
            node.status({ text: "Setting graph while running" });
            NR_setupWhileRunning();
        } else {
            node.status({ text: "Setting graph" });
            NR_setup();
        }
    } else if (msg.payload.hasOwnProperty("start")) { // Ha start érkezett
        if (FLAGS.SETUP) { // Csak a setup megléte után lehet gráfot futtatni
            if (FLAGS.IN_PROCESS) {
                node.error("Graph playing in already progress", msg);
            } else {
                FLAGS.IN_PROCESS = true;
                node.status({ text: "Started" });
                REPLY = NR_send();
            }
        } else { // Egyébként error
            node.error("Tried to start graph playing w/o setting things up", msg);
        }
    } else if (msg.payload.hasOwnProperty("status")) { // Valamiféle státuszos üzenet érkezett
        if (FLAGS.IN_PROCESS) {
            switch (msg.payload.status) {
                case 0: // Command sent
                    // Ha ilyen kerül ide, akkor valami gáz van
                    node.error("Something is not right: got msg w/ status = 0", msg);
                    break;
                case 1: // Acknowledged
                    // Hacsak nem lesznek szûrve a dolgok folyamon kívül, akkor ilyenek is jöhetnek
                    REPLY = NR_acknowledge();
                    node.status({ text: "Got acknowledge" });
                    break;
                case 2: // Done
                    // Na ezek kellenek, mennek is a 3-as outputra
                    REPLY = NR_done();
                    node.status({ text: "Got done" });
                    break;
                case 3: // Error
                    // Amíg a robot 3-as kóddal dobja a hibát...
                    node.error("Got error", msg);
                    break;
                default:
                    // Ha már switch, legyen gondolva mindenre is
                    node.error("NR_switch got message of unhandled status type", msg);
            }
        } else if (FLAGS.SETUP) {
            node.status({ text: "Logged the stuff, standing by" });
        } else {
            node.error("Playing is not in progress", msg);
        }
    } else {
        // Ésakkor ha nem lelnénk semmit, ami távolról legalább jónak tûnik
        node.error("NR_switch got an input of unhandled type", msg);
    }

    // Visszaírás
    CTX.set("flagses", FLAGS);
    CTX.set("data", DATA);
    CTX.set("monitor", MONITOR);

    return REPLY;

    //------------------------------------------------------------------------------------------------------
    // Inner functions
    //------------------------------------------------------------------------------------------------------
    function NR_setup() {
        msg = NR_simplify();
        
        // A JavaScript objektumok listájának átalakítása kétdimenziós tömbökké
        // A minimum várt objektumváz:
        //     {
        //         "number": int,
        //         "task": {
        //             "target": int,
        //             "command": {
        //                 "cmd": int(,
        //                 "param": [..,float,..])
        //             },
        //             "status": int
        //         },
        //         "parents": [..,int,..]
        //     }
        // A lista, ami lesz belõle egyszer:
        //     [..,[task_id, robot_id],..]
        DATA.vertexList = msg.payload.entries.map( (currentValue) => [currentValue["number"], currentValue["task"]["target"]] );
        // Majd másszor:
        //     [..,[parent_id_id, child_id],..]
        DATA.edgeList = [];
        msg.payload.entries.forEach( (currentValue) => currentValue["parents"].forEach( (currentValue) => DATA.edgeList.push([currentValue, this["number"]]) , currentValue) );

        // Elõször lista képzése az taskok target-jeibõl (map),
        //     majd ennek az elemeinek rendezése növekvõ sorrendbe (sort),
        //     végül szûrés a különbözõ elemekre (filter)
        DATA.robotList = msg.payload.entries.map( (currentValue)  => currentValue["task"]["target"] ).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A növekvõ (vagy csökkenõ - mindegy is, csak az azonos elemek egymás után legyenek) sorrendbe
            //     rendezett tömbön lesz a végigszaladás: mindegyik elemnél vizsgálva lesz (jó, az elsõnél nem),
            //     hogy azonos-e az elõzõvel. Ha igen, akkor az frankó, true-t ad vissza a filter, bekerül az
            //     eredménytömbbe.
            if (index === 0) {
                return true;
            } else {
                return array[index - 1] !== currentValue;
            }
        });

        // A majd küldendõ utasítások elõkészítése a könnyebb(?) keresgéléshez, illetve a parse-olónak
        // A parse-oló minimum az alábbi struktúrájú objektumot várja:
        //     {
        //         "status": int,
        //         "target": int,
        //         "id": int,
        //         "command": {
        //             "cmd": string(,
        //             "param": [..,float,..])
        //         },
        //         "desc": string
        //     }
        // 
        // Szóval objektumtöltés forEach-csel:
        DATA.commandList = {};
        msg.payload.entries.forEach(function (currentValue) {
            DATA.commandList[currentValue["number"]] = {
                "status": currentValue["task"]["status"],
                "target": currentValue["task"]["target"],
                "id": currentValue["number"],
                "command": currentValue["task"]["command"],
                "desc": currentValue["desc"]
            };
        });

        // A setup ezzel megtörtént
        FLAGS.SETUP = true;

        node.status({ text: "Setup ran", fill: "blue", shape: "dot" });
    }
    function NR_simplify() {
        // Ez a node a complex feladatok "kilaposítását" végzi.
        // A komplex feladat a kiinduló gráfban egy csomópontot képvisel és több feladat egymásutánját jelenti.
        // A kilaposítás a kövekezõk szerint történik:
        //     * A komplex-et felépítõ részfeladatok nem rendelkeznek ID-vel.
        //       Hogy mégis kapjanak, megkeresésre kerül a használt legnagyobb ID az eredeti gráfban, majd attól
        //       folytatólagosan kerül hozzárendelésre az azonosító az egyes részfeladatokhoz.
        //     * A koplex feladat elõkövetelményei az elsõ részfeladat elõkövetelményei lesznek a belépési pontot
        //       biztosítandó.
        //     * A komplex feladat ID-je az utolsó részfeladat ID-je lesz. Így az arra elõkövetelményként hivatkozó
        //       többi feladat hivatkozása nem sérül, nem kell módosítani.
        // ---------------------------------------------------------------------------------------------------------------------------------------------------
        //var node = this;
        var ENTRIES = msg.payload.entries;

        // Ha van complex utasítás
        if (ENTRIES.some(function (currentValue) { return currentValue.complex; })) {
            // A legnagyobb ID megkeresése
            DATA.highestNumber = Math.max(ENTRIES.map((currentValue) => currentValue.number).sort(descendingSort).shift(), DATA.highestNumber);

            // A vertex-ek (taskok) válogatása complex-ekre és nem-complex-ekre
            var complexVerteces = [];
            var nonComplexVerteces = [];
            ENTRIES.forEach( (curretValue) => currentValue.complex ? complexVerteces.push(currentValue) : nonComplexVerteces.push(currentValue) );
            // A függvény a fenti két tömbbe push-olja a megfelelõ taskokat

            // A complex vertex-ek kilaposítása. A replaceVertexWithSubGraph függvény minden complex feladatra
            // elõállítja a megfelelõ, nem-complex vertexek listáját, majd ezt hozzáfûzi a nonComplexVerteces
            // listához.
            complexVerteces.forEach(function (currentValue) {
                // For Each paramétere: minden complex entry-re (task-ra) lefut, az éppen "laposított" a currentValue

                // A szülõk és az ID kinyerése
                var parents = currentValue.parents;
                var number = currentValue.number;

                // A subEntry-k konverziója - minden subEntry az elõzõ leszármazottja
                var newEntries = (currentValue.task.subEntries).reduce(function (total, currentValue) {
                    if (total.length === 0) {
                        total.push({
                            "complex": false,
                            "xPos": 0,
                            "yPos": 0,
                            "number": ++(DATA.highestNumber),
                            "task": currentValue.data,
                            "desc": currentValue.desc,
                            "parents": [0]
                        });
                    } else {
                        total.push({
                            "complex": false,
                            "xPos": 0,
                            "yPos": 0,
                            "number": ++(DATA.highestNumber),
                            "task": currentValue.data,
                            "desc": currentValue.desc,
                            "parents": [total[(total.length - 1)].number]
                        });
                    }
                    return total;
                }, []);

                // Az elsõ subEntry szülei a comlex entry szülei, így a kapcsolódás a gráf többi részéhez "visszafelé" megmarad
                newEntries[0].parents = parents;

                // Az utolsó subEntry ID-je (száma) a complex Entry száma, így a kapcsolódás a gráf többi részéhez "elõrefelé" rendben
                var lastIndex = newEntries.length - 1;
                newEntries[lastIndex].number = number;

                // Korrekcióka
                (DATA.highestNumber)--;

                // Hozzácsatolás a nem complex entry-k listájához
                nonComplexVerteces = nonComplexVerteces.concat(newEntries);
            });

            // Már minden vertex nem-complex
            msg.payload.entries = nonComplexVerteces;
            node.status({ text: "Complexes flattened" });
        } else {
            node.status({ text: "Nothing to flatten" });
        }

        return msg;
    }
    function NR_setupWhileRunning() {
        msg = NR_simplify();
        // A JavaScript objektumok listájának átalakítása kétdimenziós tömbökké
        // A minimum várt objektumváz:
        //     {
        //         "number": int,
        //         "task": {
        //             "target": int,
        //             "command": {
        //                 "cmd": int(,
        //                 "param": [..,float,..])
        //             },
        //             "status": int
        //         },
        //         "parents": [..,int,..]
        //     }
        // A lista, ami lesz belõle egyszer:
        //     [..,[task_id, robot_id],..]
        var vertexList = msg.payload.entries.map( (currentValue) => [currentValue["number"], currentValue["task"]["target"]] );
        // Majd másszor:
        //     [..,[parent_id_id, child_id],..]
        var edgeList = [];
        msg.payload.entries.forEach(function (currentValue) {
            // Tömb a tömbben, így a 2D-s iterálgatás 2. D-je. Lehetett volna erre is külön függvényt írni a main
            //     rész végére, de ez most ilyen helyben-anonim lett.
            currentValue["parents"].forEach(function (v) {
                edgeList.push([v, this["number"]]);
            }, currentValue);
        });

        // Elõször lista képzése az taskok target-jeibõl (map),
        //     majd ennek az elemeinek rendezése növekvõ sorrendbe (sort),
        //     végül szûrés a különbözõ elemekre (filter)
        var robotList = msg.payload.entries.map( (currentValue) => currentValue["task"]["target"] ).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A növekvõ (vagy csökkenõ - mindegy is, csak az azonos elemek egymás után legyenek) sorrendbe
            //     rendezett tömbön lesz a végigszaladás: mindegyik elemnél vizsgálva lesz (jó, az elsõnél nem),
            //     hogy azonos-e az elõzõvel. Ha igen, akkor az frankó, true-t ad vissza a filter, bekerül az
            //     eredménytömbbe.
            if (index === 0) {
                return true;
            } else {
                return array[index - 1] !== currentValue;
            }
        });

        // A majd küldendõ utasítások elõkészítése a könnyebb(?) keresgéléshez, illetve a parse-olónak
        // A parse-oló minimum az alábbi struktúrájú objektumot várja:
        //     {
        //         "status": int,
        //         "target": int,
        //         "id": int,
        //         "command": {
        //             "cmd": string(,
        //             "param": [..,float,..])
        //         },
        //         "desc": string
        //     }
        // 
        // Szóval objektumtöltés forEach-csel:
        var commandList = {};
        msg.payload.entries.forEach(function (currentValue) {
            commandList[currentValue["number"]] = {
                "status": currentValue["task"]["status"],
                "target": currentValue["task"]["target"],
                "id": currentValue["number"],
                "command": currentValue["task"]["command"],
                "desc": currentValue["desc"]
            };
        });

        // A setup ezzel megtörtént
        FLAGS.SETUP = true;

        // Medzsik start
        // - jó lenne valami id-ellenõrzõ, hogy ne legyen duplázás, mert itt tényleg lehet gond
        DATA.vertexList = DATA.vertexList.concat(vertexList);
        DATA.doneList.forEach(function (currentValue) {
            // doneList = [..[task_id, target_id]..]
            edgeList = edgeList.filter(function (value, index, array) {
                // 'this'-ként bejött az elvégzett utasítás ID-je. Aztán az elõrelátó kódolás miatt mind
                //     az éllista, mind a csomópontok listája olyan, hogy az elsõ elemmel kelljen játszani:
                //         [..,[elvégzett utasítás id-je, child_id/target],..]
                // Itt nem szerette a szigorú összevetést
                return value[0] != this;
            }, currentValue[0]);
        });
        DATA.edgeList = DATA.edgeList.concat(edgeList);
        DATA.robotList = DATA.robotList.concat(robotList).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A növekvõ (vagy csökkenõ - mindegy is, csak az azonos elemek egymás után legyenek) sorrendbe
            //     rendezett tömbön lesz a végigszaladás: mindegyik elemnél vizsgálva lesz (jó, az elsõnél nem),
            //     hogy azonos-e az elõzõvel. Ha igen, akkor az frankó, true-t ad vissza a filter, bekerül az
            //     eredménytömbbe.
            if (index === 0) {
                return true;
            } else {
                return array[index - 1] !== currentValue;
            }
        });
        DATA.commandList = DATA.commandList.concat(commandList);

        node.status({ text: "Setup++ ran", fill: "blue", shape: "dot" });
    }
    function NR_send() {
            var VERTECES = DATA.vertexList;
            var EDGES = DATA.edgeList;
            var ROBOTS = DATA.robotList;
            var BUSY_ROBOTS = DATA.busyRobots;

            // Az elérhetõ robotok listájának képzése - halmazmûveletesen a (ROBOTS - BUSY_ROBOTS) különbség képzése
            var availableRobots = ROBOTS.filter( (value)  => !(includes(BUSY_ROBOTS, value)) );

            // Az reply listába lesznek push-olva a majd kiküldendõ üzenetek.
            // Ezeket majd egy split node szétszedi üzenetek egymásutánjára. A node.send() függvény hívása az
            //     aszinkronitásból adódóan problémákat okozott.
            var reply = [];

            // Kiküldhetõ feladat keresése minden elérhetõ robothoz, majd azok push-olása tehát az reply listába.
            // Ezek mellett, ha található küldhetõ feladat, az adott robot felvétele a BUSY_ROBOTS listába.
            availableRobots.forEach(function (value) {
                // A VERTECES lista szûrése a vizsgált médiumhozhoz tartozó feladatokra, majd a kapott listában szûrés
                //     azokra, melyeknek nem található elõkövetelménye az EDGES listában (tehát ér õket küldeni). Végül
                //     az így kapott lista egy elemének kishiftelése.
                var toBeSent = VERTECES.filter( (v) => v[1] === value ).filter(function (value, index) {
                    // Annak vizsgálata, hogy az EDGES lista (irányított gráfélek) minden eleme NEM a VERTECES lista vizsgált
                    //     elemébe mutat-e. (A szerencsétlen fogalmazás a szintaktika miatt.)
                    return EDGES.every(function (value_i) {
                        // A this itt a VERTECES lista éppen vizsgált eleme
                        // EDGES = [..,[parent_id, child_id],..] - tehát az 1-es index-szel rendelkezõ elem (child_id) vizsgáltatik.
                        return value_i[1] !== this[0] || (value_i[1] === this[0] && value_i[0] === 0);
                    }, value);
                }, EDGES).shift();

                // Annak vizsgálata, hogy találtatott-e küldhetõ feladat.
                if (toBeSent === undefined) {
                    //node.status({/*fill:"blue",shape:"dot",*/text:"No command to send."});
                } else {
                    // A talált feladat vertex-ének push-olása az reply listába.
                    reply.push(toBeSent);
                    // Illetve a vizsgált robot rögzítése a BUSY_ROBOTS listában.
                    BUSY_ROBOTS.push(value);
                    //node.status({/*fill:"green",shape:"ring",*/text:"Command sent."});
                }
            });

            // Az getSendableVertex() függvény által esetleg lefoglalt médiumok listájának visszamentése.
            DATA.busyRobots = BUSY_ROBOTS;

            // Ha nem volt seholsemmilyen feladat, akkor ne menjen ki [] lista.
            if (reply.length === 0) {
                msg = null;
            } else {
                // Egyébként meg nem a vertex kell, hanem az ahoz tartozó, parser-nek a 'Setup'-ban elõkészített
                //     objektum.
                msg.payload = reply.map( (v) => DATA.commandList[v[0]] );
                msg = msg.payload.map(function (currentValue) {
                    var reply = msg;
                    reply.payload = currentValue;
                    return reply;
                });
                msg.forEach(function (currentValue) {
                    MONITOR[currentValue.payload.target] = [currentValue.payload.status, currentValue.payload.id, currentValue.payload.desc];
                });
            }

        return msg;
    }
    function NR_acknowledge() {
        if (!(msg.payload.hasOwnProperty("id"))) { // Ha nincs id, akkor a monitorból töltés
            msg.payload.id = MONITOR[msg.payload.target][1];
            MONITOR[msg.payload.target][0] = msg.payload.status;
        } else { // Ha van id, akkor egy log
            MONITOR[msg.payload.target][0] = msg.payload.status;
        }

        if (!(msg.payload.hasOwnProperty("desc"))) { // Ha nincs leírás - ez általában nincs
            msg.payload.desc = MONITOR[msg.payload.target][2];
        }

        return null;
    }
    function NR_done() {
        // MANAGE MONITOR ---------------------------------------------------------------
        if (!(msg.payload.hasOwnProperty("id"))) { // Ha nincs id, akkor a monitorból töltés
            msg.payload.id = MONITOR[msg.payload.target][1];
            MONITOR[msg.payload.target][0] = msg.payload.status;
        } else { // Ha van id, akkor egy log
            MONITOR[msg.payload.target][0] = msg.payload.status;
        }

        if (!(msg.payload.hasOwnProperty("desc"))) { // Ha nincs leírás - ez általában nincs
            msg.payload.desc = MONITOR[msg.payload.target][2];
        }

        // RECEIVE ---------------------------------------------------------------------
        // Az elvégzett feladat kiszûrésével új vertex-lista képzése
            var VERTECES = DATA.vertexList.filter(function (value) {
                // 'this'-ként bejött az elvégzett utasítás ID-je. Aztán az elõrelátó kódolás miatt mind
                //     az éllista, mind a csomópontok listája olyan, hogy az elsõ elemmel kelljen játszani:
                //         [..,[elvégzett utasítás id-je, child_id/target],..]
                // Itt nem szerette a szigorú összevetést
                return value[0] != this;
            }, msg.payload["id"]);
            // A filter nem csereberél sorrendet, csak sorban kivesz, ha és amennyiben - iterátoros jellegû függvény volna, vagy mi
            // Itt most ellenõrzésre kerül, hogy a done az jelentett-e bármiféle módosítást. Kellene, hogy jelentsen, mert egyébként
            // a progi végtelen ciklusba futhat, az meg nem célravezetõ
            if (VERTECES.length === DATA.vertexList.length) {
                msg["newVerteces"] = VERTECES;
                msg["oldVerteces"] = DATA.vertexList;
                node.error("Got a done that did not remove any vertex from the vertexlist", msg);
                return null;
            }

            // Az elvégzett feladat jelentette elõkövetelmények kiszûrésével új éllista képzése
            var EDGES = DATA.edgeList.filter(function (value) {
                // 'this'-ként bejött az elvégzett utasítás ID-je. Aztán az elõrelátó kódolás miatt mind
                //     az éllista, mind a csomópontok listája olyan, hogy az elsõ elemmel kelljen játszani:
                //         [..,[elvégzett utasítás id-je, child_id/target],..]
                // Itt nem szerette a szigorú összevetést
                return value[0] != this;
            }, msg.payload["id"]);

            // A feladatot elvégzõ robot kiszûrésével a foglalt robotok új listájának képzése
            var BUSY_ROBOTS = DATA.busyRobots.filter(function (value) {
                // Itt nem szerette a szigorú összevetést
                return value != this;
            }, msg.payload["target"]);

            // Visszamentés és felülírás
            DATA.vertexList = VERTECES;
            DATA.edgeList = EDGES;
            DATA.busyRobots = BUSY_ROBOTS;
            DATA.doneList.push([msg.payload.id, msg.payload.target]);

            // Csak az üzenet ténye lesz a fontos a következõ node-nak - a kényszeres takarítás helye
            msg.payload = null;

            node.status({ text: "Got 'done'" });

            // Lehet, hogy végzett is a dolog
            if (VERTECES.length === 0) {
                FLAGS.IN_PROCESS = false;
                FLAGS.SETUP = false;
                node.status({ text: "Graph played. Done" });
            }

        return NR_send();
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    // Az iterátorfüggvények paraméterfüggvényei
    function descendingSort(a, b) {
        return b - a;
    }
    function ascendingSort(a, b) {
        return a - b;
    }
    function includes(array, element) {
        var i = 0;
        var flag = false;
        for (; i < array.length; ++i) {
            if (array[i] === element) {
                flag = true;
                break;
            }
        }
        return flag;
    }
}

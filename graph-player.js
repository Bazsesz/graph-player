module.exports = function (RED) {
    function GraphPlayerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', (msg) => node.send(NR_switch(msg, node)));
    }
    RED.nodes.registerType("graph-player", GraphPlayerNode);
}

const DEFAULT_MONITOR = {};
const DEFAULT_FLAGS = { "SETUP": false, "IN_PROCESS": false };
const DEFAULT_DATA = {
    "vertexList": [],
    "edgeList": [],
    "robotList": [],
    "busyRobots": [],
    "doneList": [],
    "commandList": {},
    "highestNumber": 0
};

function NR_switch(msg, node) {
    // N�h�ny glob�lis
    var CTX = node.context();

    var DATA = CTX.get("data") || DEFAULT_DATA;
    var MONITOR = CTX.get("monitor") || DEFAULT_MONITOR;
    var FLAGS = CTX.get("flagses") || DEFAULT_FLAGS;

    var REPLY = null;

    // TFH a felhaszn�l� j�indulat�:
    //     * A node pontosan akkor kapott gr�fot, hogyha van annak a payloadnak graphID property-je
    //     * A node pontosan akkor kapott reset parancsot, hogyha a payloadnak van reset tulajdons�ga
    //     * A node pontosan akkor kapott start parancsot, hogyha a payloadnak van start tulajdons�ga
    //
    if (msg.payload.hasOwnProperty("reset")) {
        // A kritikus �s haszn�lt dolgok alaphelyzetbe �ll�t�sa
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

    } else if (msg.payload.hasOwnProperty("graphID")) { // Teh�t ha gr�f j�tt
        if (FLAGS.IN_PROCESS) {
            // Egyenl�re legyen �gy, k�l�n �gon
            node.status({ text: "Setting graph while running" });
            NR_setupWhileRunning();
        } else {
            node.status({ text: "Setting graph" });
            NR_setup();
        }
    } else if (msg.payload.hasOwnProperty("start")) { // Ha start �rkezett
        if (FLAGS.SETUP) { // Csak a setup megl�te ut�n lehet gr�fot futtatni
            if (FLAGS.IN_PROCESS) {
                node.error("Graph playing in already progress", msg);
            } else {
                FLAGS.IN_PROCESS = true;
                node.status({ text: "Started" });
                REPLY = NR_send();
            }
        } else { // Egy�bk�nt error
            node.error("Tried to start graph playing w/o setting things up", msg);
        }
    } else if (msg.payload.hasOwnProperty("status")) { // Valamif�le st�tuszos �zenet �rkezett
        if (FLAGS.IN_PROCESS) {
            switch (msg.payload.status) {
                case 0: // Command sent
                    // Ha ilyen ker�l ide, akkor valami g�z van
                    node.error("Something is not right: got msg w/ status = 0", msg);
                    break;
                case 1: // Acknowledged
                    // Hacsak nem lesznek sz�rve a dolgok folyamon k�v�l, akkor ilyenek is j�hetnek
                    REPLY = NR_acknowledge();
                    node.status({ text: "Got acknowledge" });
                    break;
                case 2: // Done
                    // Na ezek kellenek, mennek is a 3-as outputra
                    REPLY = NR_done();
                    node.status({ text: "Got done" });
                    break;
                case 3: // Error
                    // Am�g a robot 3-as k�ddal dobja a hib�t...
                    node.error("Got error", msg);
                    break;
                default:
                    // Ha m�r switch, legyen gondolva mindenre is
                    node.error("NR_switch got message of unhandled status type", msg);
            }
        } else if (FLAGS.SETUP) {
            node.status({ text: "Logged the stuff, standing by" });
        } else {
            node.error("Playing is not in progress", msg);
        }
    } else {
        // �sakkor ha nem leln�nk semmit, ami t�volr�l legal�bb j�nak t�nik
        node.error("NR_switch got an input of unhandled type", msg);
    }

    // Vissza�r�s
    CTX.set("flagses", FLAGS);
    CTX.set("data", DATA);
    CTX.set("monitor", MONITOR);

    return REPLY;

    //------------------------------------------------------------------------------------------------------
    // Inner functions
    //------------------------------------------------------------------------------------------------------
    function NR_setup() {
        msg = NR_simplify();
        
        // A JavaScript objektumok list�j�nak �talak�t�sa k�tdimenzi�s t�mb�kk�
        // A minimum v�rt objektumv�z:
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
        // A lista, ami lesz bel�le egyszer:
        //     [..,[task_id, robot_id],..]
        DATA.vertexList = msg.payload.entries.map( (currentValue) => [currentValue["number"], currentValue["task"]["target"]] );
        // Majd m�sszor:
        //     [..,[parent_id_id, child_id],..]
        DATA.edgeList = [];
        msg.payload.entries.forEach( (currentValue) => currentValue["parents"].forEach( (currentValue) => DATA.edgeList.push([currentValue, this["number"]]) , currentValue) );

        // El�sz�r lista k�pz�se az taskok target-jeib�l (map),
        //     majd ennek az elemeinek rendez�se n�vekv� sorrendbe (sort),
        //     v�g�l sz�r�s a k�l�nb�z� elemekre (filter)
        DATA.robotList = msg.payload.entries.map( (currentValue)  => currentValue["task"]["target"] ).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A n�vekv� (vagy cs�kken� - mindegy is, csak az azonos elemek egym�s ut�n legyenek) sorrendbe
            //     rendezett t�mb�n lesz a v�gigszalad�s: mindegyik elemn�l vizsg�lva lesz (j�, az els�n�l nem),
            //     hogy azonos-e az el�z�vel. Ha igen, akkor az frank�, true-t ad vissza a filter, beker�l az
            //     eredm�nyt�mbbe.
            if (index === 0) {
                return true;
            } else {
                return array[index - 1] !== currentValue;
            }
        });

        // A majd k�ldend� utas�t�sok el�k�sz�t�se a k�nnyebb(?) keresg�l�shez, illetve a parse-ol�nak
        // A parse-ol� minimum az al�bbi strukt�r�j� objektumot v�rja:
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
        // Sz�val objektumt�lt�s forEach-csel:
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

        // A setup ezzel megt�rt�nt
        FLAGS.SETUP = true;

        node.status({ text: "Setup ran", fill: "blue", shape: "dot" });
    }
    function NR_simplify() {
        // Ez a node a complex feladatok "kilapos�t�s�t" v�gzi.
        // A komplex feladat a kiindul� gr�fban egy csom�pontot k�pvisel �s t�bb feladat egym�sut�nj�t jelenti.
        // A kilapos�t�s a k�vekez�k szerint t�rt�nik:
        //     * A komplex-et fel�p�t� r�szfeladatok nem rendelkeznek ID-vel.
        //       Hogy m�gis kapjanak, megkeres�sre ker�l a haszn�lt legnagyobb ID az eredeti gr�fban, majd att�l
        //       folytat�lagosan ker�l hozz�rendel�sre az azonos�t� az egyes r�szfeladatokhoz.
        //     * A koplex feladat el�k�vetelm�nyei az els� r�szfeladat el�k�vetelm�nyei lesznek a bel�p�si pontot
        //       biztos�tand�.
        //     * A komplex feladat ID-je az utols� r�szfeladat ID-je lesz. �gy az arra el�k�vetelm�nyk�nt hivatkoz�
        //       t�bbi feladat hivatkoz�sa nem s�r�l, nem kell m�dos�tani.
        // ---------------------------------------------------------------------------------------------------------------------------------------------------
        //var node = this;
        var ENTRIES = msg.payload.entries;

        // Ha van complex utas�t�s
        if (ENTRIES.some(function (currentValue) { return currentValue.complex; })) {
            // A legnagyobb ID megkeres�se
            DATA.highestNumber = Math.max(ENTRIES.map((currentValue) => currentValue.number).sort(descendingSort).shift(), DATA.highestNumber);

            // A vertex-ek (taskok) v�logat�sa complex-ekre �s nem-complex-ekre
            var complexVerteces = [];
            var nonComplexVerteces = [];
            ENTRIES.forEach( (curretValue) => currentValue.complex ? complexVerteces.push(currentValue) : nonComplexVerteces.push(currentValue) );
            // A f�ggv�ny a fenti k�t t�mbbe push-olja a megfelel� taskokat

            // A complex vertex-ek kilapos�t�sa. A replaceVertexWithSubGraph f�ggv�ny minden complex feladatra
            // el��ll�tja a megfelel�, nem-complex vertexek list�j�t, majd ezt hozz�f�zi a nonComplexVerteces
            // list�hoz.
            complexVerteces.forEach(function (currentValue) {
                // For Each param�tere: minden complex entry-re (task-ra) lefut, az �ppen "lapos�tott" a currentValue

                // A sz�l�k �s az ID kinyer�se
                var parents = currentValue.parents;
                var number = currentValue.number;

                // A subEntry-k konverzi�ja - minden subEntry az el�z� lesz�rmazottja
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

                // Az els� subEntry sz�lei a comlex entry sz�lei, �gy a kapcsol�d�s a gr�f t�bbi r�sz�hez "visszafel�" megmarad
                newEntries[0].parents = parents;

                // Az utols� subEntry ID-je (sz�ma) a complex Entry sz�ma, �gy a kapcsol�d�s a gr�f t�bbi r�sz�hez "el�refel�" rendben
                var lastIndex = newEntries.length - 1;
                newEntries[lastIndex].number = number;

                // Korrekci�ka
                (DATA.highestNumber)--;

                // Hozz�csatol�s a nem complex entry-k list�j�hoz
                nonComplexVerteces = nonComplexVerteces.concat(newEntries);
            });

            // M�r minden vertex nem-complex
            msg.payload.entries = nonComplexVerteces;
            node.status({ text: "Complexes flattened" });
        } else {
            node.status({ text: "Nothing to flatten" });
        }

        return msg;
    }
    function NR_setupWhileRunning() {
        msg = NR_simplify();
        // A JavaScript objektumok list�j�nak �talak�t�sa k�tdimenzi�s t�mb�kk�
        // A minimum v�rt objektumv�z:
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
        // A lista, ami lesz bel�le egyszer:
        //     [..,[task_id, robot_id],..]
        var vertexList = msg.payload.entries.map( (currentValue) => [currentValue["number"], currentValue["task"]["target"]] );
        // Majd m�sszor:
        //     [..,[parent_id_id, child_id],..]
        var edgeList = [];
        msg.payload.entries.forEach(function (currentValue) {
            // T�mb a t�mbben, �gy a 2D-s iter�lgat�s 2. D-je. Lehetett volna erre is k�l�n f�ggv�nyt �rni a main
            //     r�sz v�g�re, de ez most ilyen helyben-anonim lett.
            currentValue["parents"].forEach(function (v) {
                edgeList.push([v, this["number"]]);
            }, currentValue);
        });

        // El�sz�r lista k�pz�se az taskok target-jeib�l (map),
        //     majd ennek az elemeinek rendez�se n�vekv� sorrendbe (sort),
        //     v�g�l sz�r�s a k�l�nb�z� elemekre (filter)
        var robotList = msg.payload.entries.map( (currentValue) => currentValue["task"]["target"] ).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A n�vekv� (vagy cs�kken� - mindegy is, csak az azonos elemek egym�s ut�n legyenek) sorrendbe
            //     rendezett t�mb�n lesz a v�gigszalad�s: mindegyik elemn�l vizsg�lva lesz (j�, az els�n�l nem),
            //     hogy azonos-e az el�z�vel. Ha igen, akkor az frank�, true-t ad vissza a filter, beker�l az
            //     eredm�nyt�mbbe.
            if (index === 0) {
                return true;
            } else {
                return array[index - 1] !== currentValue;
            }
        });

        // A majd k�ldend� utas�t�sok el�k�sz�t�se a k�nnyebb(?) keresg�l�shez, illetve a parse-ol�nak
        // A parse-ol� minimum az al�bbi strukt�r�j� objektumot v�rja:
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
        // Sz�val objektumt�lt�s forEach-csel:
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

        // A setup ezzel megt�rt�nt
        FLAGS.SETUP = true;

        // Medzsik start
        // - j� lenne valami id-ellen�rz�, hogy ne legyen dupl�z�s, mert itt t�nyleg lehet gond
        DATA.vertexList = DATA.vertexList.concat(vertexList);
        DATA.doneList.forEach(function (currentValue) {
            // doneList = [..[task_id, target_id]..]
            edgeList = edgeList.filter(function (value, index, array) {
                // 'this'-k�nt bej�tt az elv�gzett utas�t�s ID-je. Azt�n az el�rel�t� k�dol�s miatt mind
                //     az �llista, mind a csom�pontok list�ja olyan, hogy az els� elemmel kelljen j�tszani:
                //         [..,[elv�gzett utas�t�s id-je, child_id/target],..]
                // Itt nem szerette a szigor� �sszevet�st
                return value[0] != this;
            }, currentValue[0]);
        });
        DATA.edgeList = DATA.edgeList.concat(edgeList);
        DATA.robotList = DATA.robotList.concat(robotList).sort(ascendingSort).filter(function (currentValue, index, array) {
            // A n�vekv� (vagy cs�kken� - mindegy is, csak az azonos elemek egym�s ut�n legyenek) sorrendbe
            //     rendezett t�mb�n lesz a v�gigszalad�s: mindegyik elemn�l vizsg�lva lesz (j�, az els�n�l nem),
            //     hogy azonos-e az el�z�vel. Ha igen, akkor az frank�, true-t ad vissza a filter, beker�l az
            //     eredm�nyt�mbbe.
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

            // Az el�rhet� robotok list�j�nak k�pz�se - halmazm�veletesen a (ROBOTS - BUSY_ROBOTS) k�l�nbs�g k�pz�se
            var availableRobots = ROBOTS.filter( (value)  => !(includes(BUSY_ROBOTS, value)) );

            // Az reply list�ba lesznek push-olva a majd kik�ldend� �zenetek.
            // Ezeket majd egy split node sz�tszedi �zenetek egym�sut�nj�ra. A node.send() f�ggv�ny h�v�sa az
            //     aszinkronit�sb�l ad�d�an probl�m�kat okozott.
            var reply = [];

            // Kik�ldhet� feladat keres�se minden el�rhet� robothoz, majd azok push-ol�sa teh�t az reply list�ba.
            // Ezek mellett, ha tal�lhat� k�ldhet� feladat, az adott robot felv�tele a BUSY_ROBOTS list�ba.
            availableRobots.forEach(function (value) {
                // A VERTECES lista sz�r�se a vizsg�lt m�diumhozhoz tartoz� feladatokra, majd a kapott list�ban sz�r�s
                //     azokra, melyeknek nem tal�lhat� el�k�vetelm�nye az EDGES list�ban (teh�t �r �ket k�ldeni). V�g�l
                //     az �gy kapott lista egy elem�nek kishiftel�se.
                var toBeSent = VERTECES.filter( (v) => v[1] === value ).filter(function (value, index) {
                    // Annak vizsg�lata, hogy az EDGES lista (ir�ny�tott gr�f�lek) minden eleme NEM a VERTECES lista vizsg�lt
                    //     elem�be mutat-e. (A szerencs�tlen fogalmaz�s a szintaktika miatt.)
                    return EDGES.every(function (value_i) {
                        // A this itt a VERTECES lista �ppen vizsg�lt eleme
                        // EDGES = [..,[parent_id, child_id],..] - teh�t az 1-es index-szel rendelkez� elem (child_id) vizsg�ltatik.
                        return value_i[1] !== this[0] || (value_i[1] === this[0] && value_i[0] === 0);
                    }, value);
                }, EDGES).shift();

                // Annak vizsg�lata, hogy tal�ltatott-e k�ldhet� feladat.
                if (toBeSent === undefined) {
                    //node.status({/*fill:"blue",shape:"dot",*/text:"No command to send."});
                } else {
                    // A tal�lt feladat vertex-�nek push-ol�sa az reply list�ba.
                    reply.push(toBeSent);
                    // Illetve a vizsg�lt robot r�gz�t�se a BUSY_ROBOTS list�ban.
                    BUSY_ROBOTS.push(value);
                    //node.status({/*fill:"green",shape:"ring",*/text:"Command sent."});
                }
            });

            // Az getSendableVertex() f�ggv�ny �ltal esetleg lefoglalt m�diumok list�j�nak visszament�se.
            DATA.busyRobots = BUSY_ROBOTS;

            // Ha nem volt seholsemmilyen feladat, akkor ne menjen ki [] lista.
            if (reply.length === 0) {
                msg = null;
            } else {
                // Egy�bk�nt meg nem a vertex kell, hanem az ahoz tartoz�, parser-nek a 'Setup'-ban el�k�sz�tett
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
        if (!(msg.payload.hasOwnProperty("id"))) { // Ha nincs id, akkor a monitorb�l t�lt�s
            msg.payload.id = MONITOR[msg.payload.target][1];
            MONITOR[msg.payload.target][0] = msg.payload.status;
        } else { // Ha van id, akkor egy log
            MONITOR[msg.payload.target][0] = msg.payload.status;
        }

        if (!(msg.payload.hasOwnProperty("desc"))) { // Ha nincs le�r�s - ez �ltal�ban nincs
            msg.payload.desc = MONITOR[msg.payload.target][2];
        }

        return null;
    }
    function NR_done() {
        // MANAGE MONITOR ---------------------------------------------------------------
        if (!(msg.payload.hasOwnProperty("id"))) { // Ha nincs id, akkor a monitorb�l t�lt�s
            msg.payload.id = MONITOR[msg.payload.target][1];
            MONITOR[msg.payload.target][0] = msg.payload.status;
        } else { // Ha van id, akkor egy log
            MONITOR[msg.payload.target][0] = msg.payload.status;
        }

        if (!(msg.payload.hasOwnProperty("desc"))) { // Ha nincs le�r�s - ez �ltal�ban nincs
            msg.payload.desc = MONITOR[msg.payload.target][2];
        }

        // RECEIVE ---------------------------------------------------------------------
        // Az elv�gzett feladat kisz�r�s�vel �j vertex-lista k�pz�se
            var VERTECES = DATA.vertexList.filter(function (value) {
                // 'this'-k�nt bej�tt az elv�gzett utas�t�s ID-je. Azt�n az el�rel�t� k�dol�s miatt mind
                //     az �llista, mind a csom�pontok list�ja olyan, hogy az els� elemmel kelljen j�tszani:
                //         [..,[elv�gzett utas�t�s id-je, child_id/target],..]
                // Itt nem szerette a szigor� �sszevet�st
                return value[0] != this;
            }, msg.payload["id"]);
            // A filter nem csereber�l sorrendet, csak sorban kivesz, ha �s amennyiben - iter�toros jelleg� f�ggv�ny volna, vagy mi
            // Itt most ellen�rz�sre ker�l, hogy a done az jelentett-e b�rmif�le m�dos�t�st. Kellene, hogy jelentsen, mert egy�bk�nt
            // a progi v�gtelen ciklusba futhat, az meg nem c�lravezet�
            if (VERTECES.length === DATA.vertexList.length) {
                msg["newVerteces"] = VERTECES;
                msg["oldVerteces"] = DATA.vertexList;
                node.error("Got a done that did not remove any vertex from the vertexlist", msg);
                return null;
            }

            // Az elv�gzett feladat jelentette el�k�vetelm�nyek kisz�r�s�vel �j �llista k�pz�se
            var EDGES = DATA.edgeList.filter(function (value) {
                // 'this'-k�nt bej�tt az elv�gzett utas�t�s ID-je. Azt�n az el�rel�t� k�dol�s miatt mind
                //     az �llista, mind a csom�pontok list�ja olyan, hogy az els� elemmel kelljen j�tszani:
                //         [..,[elv�gzett utas�t�s id-je, child_id/target],..]
                // Itt nem szerette a szigor� �sszevet�st
                return value[0] != this;
            }, msg.payload["id"]);

            // A feladatot elv�gz� robot kisz�r�s�vel a foglalt robotok �j list�j�nak k�pz�se
            var BUSY_ROBOTS = DATA.busyRobots.filter(function (value) {
                // Itt nem szerette a szigor� �sszevet�st
                return value != this;
            }, msg.payload["target"]);

            // Visszament�s �s fel�l�r�s
            DATA.vertexList = VERTECES;
            DATA.edgeList = EDGES;
            DATA.busyRobots = BUSY_ROBOTS;
            DATA.doneList.push([msg.payload.id, msg.payload.target]);

            // Csak az �zenet t�nye lesz a fontos a k�vetkez� node-nak - a k�nyszeres takar�t�s helye
            msg.payload = null;

            node.status({ text: "Got 'done'" });

            // Lehet, hogy v�gzett is a dolog
            if (VERTECES.length === 0) {
                FLAGS.IN_PROCESS = false;
                FLAGS.SETUP = false;
                node.status({ text: "Graph played. Done" });
            }

        return NR_send();
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    // Az iter�torf�ggv�nyek param�terf�ggv�nyei
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
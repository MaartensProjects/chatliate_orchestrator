'use strict';
//INSTANTIATE
//import
const Bull = require('bull');
var randomstring = require("randomstring");


//instantiate Redis queues
try {
    var inboundDbRequestQueue = new Bull(process.env.DBREQUESTINBOUNDQ, process.env.REDIS);
    var outboundDbRequestQueue = new Bull(process.env.DBREQUESTOUTBOUNDQ, process.env.REDIS);
    var inboundStatsDbRequestQueue = new Bull(process.env.STATSDBREQUESTINBOUNDQ, process.env.REDIS);
    var outboundStatsDbRequestQueue = new Bull(process.env.STATSDBREQUESTOUTBOUNDQ, process.env.REDIS);
    var inboundRasaActionQueue = new Bull(process.env.RASAACTIONINBOUNDQ, process.env.REDIS);
    var communicatorOutboundQueue = new Bull(process.env.COMMUNICATOROUTBOUNDQ, process.env.REDIS);

} catch (e) {
    console.error(e); process.exit(1)
}
const outboundActionQueues = [];

//RASA ACTION INTEGRATION
//Monitor inbound action calls from Rasa and post back
async function postToOutboundRasaActionQueue(callbackq, user, msg) {
    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator adding msg to outboundRasaActionQueue.'); }

    var outboundrq = {};
    var rqset = false;

    //check if queue already instantiated
    outboundActionQueues.forEach(element => {
        if (callbackq == element.qname) {
            outboundrq = element.qobject;
            rqset = true;
        }
    });

    //if not, instantiate
    if (rqset == false) {

        //always log this
        console.log('instantiating outboundActionRasaQ for first time. for User: ' + user);
        try {
            outboundrq = new Bull(callbackq, process.env.REDIS);
        } catch (e) {
            console.error(e); process.exit(1)
        }
        //and add to queues instantiated
        outboundActionQueues.push({ qname: callbackq, qobject: outboundrq });
    }

    //unescape msg from special internal chars before sending out
    var a = await outboundrq.add({
        user: user,
        msg: JSON.parse(cleanOutboundUserMessage(JSON.stringify(msg)))
    }, { removeOnComplete: true });
};


inboundRasaActionQueue.process(async (qmsg) => {

    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator reading from inboundRasaActionQueue'); }

    //generic vars
    var user = qmsg.data.user;
    var callbackq = qmsg.data.callbackq;
    var actionvars = parseActionVars(qmsg.data.msg);
    var originalreq = JSON.parse(qmsg.data.msg);
    var query = {};

    //actions
    if (actionvars.action == "process_affirm") {
        if (process.env.LOGGING == "TRUE") { console.log('next action: process_affirm'); }
        //determine next action

        try {
            if (originalreq.tracker.slots.retrieved_conversation == null) {
                //defaultvals
                actionvars.nextactionp = "instruct_utter_default_fallback"
                actionvars.slotname = ""
                query.setvalue = ""

                //sort events and find latest utterance
                var latestutterance = { name: "", timestamp: 0 };

                originalreq.tracker.events.forEach(ev => {
                    if (ev.hasOwnProperty("name")) {
                        if (ev.name.slice(0, 6) == "utter_" && latestutterance.timestamp < ev.timestamp) {
                            if (ev.name != "utter_default_fallback" && ev.name != "utter_standardanswer") {
                                latestutterance = ev
                            }
                        }
                    }
                });

                if (latestutterance.name == "utter_next_chatbot_application_question") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_affirm: latest utterance is ' + latestutterance.name); }

                    //find uttered chatbot application question
                    var lastaskedq = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question

                    if (process.env.LOGGING == "TRUE") { console.log('Last asked chatbot appl question is ' + JSON.stringify(lastaskedq)); }

                    //If affirmintent, trigger intent
                    if (lastaskedq.hasOwnProperty("affirmIntent")) {
                        actionvars.nextactionp = lastaskedq.affirmIntent
                        actionvars.slotname = lastaskedq.affirmQualexSlotName
                        query.setvalue = lastaskedq.affirmQualex
                    } else {
                        if (lastaskedq.hasOwnProperty("denyIntent")) {
                            actionvars.nextactionp = lastaskedq.denyIntent
                        }
                    }

                    //If affirmqualex not allowed, trigger I'dont understand
                }

                if (latestutterance.name == "utter_ask_find_chatbots_informed_qualex") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_affirm: latest utterance is ' + latestutterance.name); }

                    var searchedq = []

                    if (JSON.parse(qmsg.data.msg).tracker.slots.offered_qualex != null) {
                        searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.offered_qualex)
                    }

                    if (JSON.parse(qmsg.data.msg).tracker.slots.desfut_qualex != null) {
                        searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.desfut_qualex)
                    }

                    if (JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex != null) {
                        searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex)
                    }

                    //if offered/desfut qualex mentioned
                    if (searchedq[0] != null) {
                        //search with parsed qualex
                        actionvars.nextactionp = "instruct_enquire_chatbot"
                        actionvars.slotname = "searched_qualex"
                        query.setvalue = searchedq

                    } else {
                        //otherwise, ask what kind of chatbots to look for
                        actionvars.nextactionp = "instruct_utter_ask_chatbotsearch"
                    }

                }

                if (latestutterance.name == "utter_stop_chatbotapplication") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_affirm: latest utterance is ' + latestutterance.name); }

                    actionvars.nextactionp = "instruct_utter_approve_stop_chatbotapplication"

                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "all_retrieved_chatbot_application_questions", nextactionp: "" });
                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "retrieved_chatbot_application_questions", nextactionp: "" });
                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "next_chatbot_application_question", nextactionp: "" });
                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "last_chatbot_application_question", nextactionp: "" });
                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "chatbot_reference", nextactionp: "" });
                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "match_percentage", nextactionp: "" });

                }
            } else {
                if (process.env.LOGGING == "TRUE") { console.log('process_approve: persisted conversation set. save response'); }

                actionvars.nextactionp = "instruct_utter_ack"
                actionvars.slotname = ""

                query.action = "updatepush"
                query.entity = "persistedConversation"
                query._id = originalreq.tracker.slots.retrieved_conversation.match(/<id.*>((.|\n)*?)<\/id>/)[1]

                var conversationsubject = "No subject"
                var tenantsettings = {}

                if (originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/) != null) {
                    conversationsubject = originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/)[1]
                }


                if (originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/) != null) {
                    tenantsettings = JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/)[1]))
                }

                query.updatepushquerynewvalues = { "conversation": { timestamp: Date.now(), user: originalreq.tracker.slots.conversation_email, text: originalreq.tracker.latest_message.text, chatliateresponse: "false" } }

                JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<users.*>((.|\n)*?)<\/users>/)[1])).forEach(usr => {

                    //dont send to the poster of the message
                    if (usr.email != originalreq.tracker.slots.conversation_email) {
                        //post new message comms to communicator
                        postToCommunicatorQueue(user, JSON.stringify({ commstype: "newMessagePersistedChat", tracker: originalreq.tracker, receiverid: usr.email, user: usr, messagesender: originalreq.tracker.slots.conversation_email, tenantsettings: tenantsettings, conversationsubject: conversationsubject, conversationid: query._id }))
                    }

                });
            }

            //update default msg, if nextaction
            if (actionvars.nextactionp == "instruct_utter_default_fallback") {
                if (originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/) != null) {
                    var prevdeffb = 0

                    if (originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/) != null) {
                        prevdeffb = Number(originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/)[1])
                    }

                    prevdeffb++

                    var deffbtxt = originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/)[1]
                    var deffbxtra = ""
                    var maxprevdeffbset = false

                    if (originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/) != null && originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/) != null) {
                        maxprevdeffbset = true
                        var maxprevdeffb = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/)[1]
                        var maxprevdeffbmsg = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/)[1]
                    }

                    //chatbot always overrules
                    if (originalreq.tracker.slots.chatbot_reference != null) {
                        if (originalreq.tracker.slots.chatbot_reference[0] != null) {
                            if (originalreq.tracker.slots.chatbot_reference[0].deffbmsg != null) {
                                deffbtxt = originalreq.tracker.slots.chatbot_reference[0].deffbmsg
                            }

                            if (originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb != null && originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg != null) {
                                maxprevdeffbset = true
                                var maxprevdeffb = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb
                                var maxprevdeffbmsg = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg
                            }

                        }
                    }

                    if (maxprevdeffbset) {
                        deffbxtra = "<maxprevdeffb>" + maxprevdeffb + "</maxprevdeffb><maxprevdeffbmsg>" + maxprevdeffbmsg + "</maxprevdeffbmsg>"
                        if (prevdeffb >= maxprevdeffb) {
                            deffbtxt = maxprevdeffbmsg
                            prevdeffb = 0
                        }
                    }

                    postBackResults(callbackq, user, { setvalue: "<text>" + deffbtxt + "</text><prevdeffb>" + prevdeffb + "</prevdeffb>" + deffbxtra }, originalreq, { slotname: "defaultfallback", nextactionp: "" });
                } else {
                    if (process.env.ERRORLOGGING == "TRUE") { console.log('something is off: No default fallback msg found'); }
                }

            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_affirm: ' + e); }
        }
    }

    if (actionvars.action == "process_deny") {
        try {
            if (originalreq.tracker.slots.retrieved_conversation == null) {
                if (process.env.LOGGING == "TRUE") { console.log('next action: process_deny'); }
                //determine next action

                //defaultvals
                actionvars.nextactionp = "instruct_utter_default_fallback"
                actionvars.slotname = ""
                query.setvalue = ""

                //sort events and find latest utterance
                var latestutterance = { name: "", timestamp: 0 };

                originalreq.tracker.events.forEach(ev => {
                    if (ev.hasOwnProperty("name")) {
                        if (ev.name.slice(0, 6) == "utter_" && latestutterance.timestamp < ev.timestamp) {
                            if (ev.name != "utter_default_fallback" && ev.name != "utter_standardanswer") {
                                latestutterance = ev
                            }
                        }
                    }
                });

                if (latestutterance.name == "utter_next_chatbot_application_question") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_deny: latest utterance is ' + latestutterance.name); }

                    //find uttered chatbot application question
                    var lastaskedq = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question

                    if (process.env.LOGGING == "TRUE") { console.log('Last asked chatbot appl question is ' + JSON.stringify(lastaskedq)); }

                    //If denyintent, trigger intent
                    if (lastaskedq.hasOwnProperty("denyIntent")) {
                        actionvars.nextactionp = lastaskedq.denyIntent
                        actionvars.slotname = lastaskedq.denyQualexSlotName
                        query.setvalue = lastaskedq.denyQualex
                    } else {
                        if (lastaskedq.hasOwnProperty("affirmIntent")) {
                            actionvars.nextactionp = lastaskedq.affirmIntent
                        }
                    }
                }


                if (latestutterance.name == "utter_ask_find_chatbots_informed_qualex") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_deny: latest utterance is ' + latestutterance.name); }

                    actionvars.nextactionp = "instruct_utter_stop_chatbotsearch"

                }

                if (latestutterance.name == "utter_stop_chatbotapplication") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_affirm: latest utterance is ' + latestutterance.name); }

                    actionvars.nextactionp = "instruct_utter_deny_stop_chatbotapplication"

                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "", nextactionp: "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true" });
                }
            } else {
                if (process.env.LOGGING == "TRUE") { console.log('process_deny: persisted conversation set. save response'); }

                actionvars.nextactionp = "instruct_utter_ack"
                actionvars.slotname = ""

                query.action = "updatepush"
                query.entity = "persistedConversation"
                query._id = originalreq.tracker.slots.retrieved_conversation.match(/<id.*>((.|\n)*?)<\/id>/)[1]

                var conversationsubject = "No subject"
                var tenantsettings = {}

                if (originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/) != null) {
                    conversationsubject = originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/)[1]
                }


                if (originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/) != null) {
                    tenantsettings = JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/)[1]))
                }

                query.updatepushquerynewvalues = { "conversation": { timestamp: Date.now(), user: originalreq.tracker.slots.conversation_email, text: originalreq.tracker.latest_message.text, chatliateresponse: "false" } }

                JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<users.*>((.|\n)*?)<\/users>/)[1])).forEach(usr => {

                    //dont send to the poster of the message
                    if (usr.email != originalreq.tracker.slots.conversation_email) {
                        //post new message comms to communicator
                        postToCommunicatorQueue(user, JSON.stringify({ commstype: "newMessagePersistedChat", tracker: originalreq.tracker, receiverid: usr.email, user: usr, messagesender: originalreq.tracker.slots.conversation_email, tenantsettings: tenantsettings, conversationsubject: conversationsubject, conversationid: query._id }))
                    }

                });
            }

            //update default msg, if nextaction
            if (actionvars.nextactionp == "instruct_utter_default_fallback") {
                if (originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/) != null) {
                    var prevdeffb = 0

                    if (originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/) != null) {
                        prevdeffb = originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/)[1]
                    }

                    var deffbtxt = originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/)[1]
                    var deffbxtra = ""

                    if (originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/) != null && originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/) != null) {
                        var maxprevdeffb = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/)[1]
                        deffbxtra = "<maxprevdeffb>" + maxprevdeffb + "</maxprevdeffb><maxprevdeffbmsg>" + originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/)[1] + "</maxprevdeffbmsg>"

                        if (prevdeffb >= maxprevdeffb) {
                            deffbtxt = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/)[1]
                            prevdeffb = 0
                        }
                    }


                    postBackResults(callbackq, user, { setvalue: "<text>" + deffbtxt + "</text><prevdeffb>" + prevdeffb + "</prevdeffb>" + deffbxtra }, originalreq, { slotname: "defaultfallback", nextactionp: "" });
                } else {
                    if (process.env.ERRORLOGGING == "TRUE") { console.log('something is off: No default fallback msg found'); }
                }

            }

            //update default msg, if nextaction
            if (actionvars.nextactionp == "instruct_utter_default_fallback") {
                if (originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/) != null) {
                    var prevdeffb = 0

                    if (originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/) != null) {
                        prevdeffb = Number(originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/)[1])
                    }

                    prevdeffb++

                    var deffbtxt = originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/)[1]
                    var deffbxtra = ""
                    var maxprevdeffbset = false

                    if (originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/) != null && originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/) != null) {
                        maxprevdeffbset = true
                        var maxprevdeffb = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/)[1]
                        var maxprevdeffbmsg = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/)[1]
                    }

                    //chatbot always overrules
                    if (originalreq.tracker.slots.chatbot_reference != null) {
                        if (originalreq.tracker.slots.chatbot_reference[0] != null) {
                            if (originalreq.tracker.slots.chatbot_reference[0].deffbmsg != null) {
                                deffbtxt = originalreq.tracker.slots.chatbot_reference[0].deffbmsg
                            }

                            if (originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb != null && originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg != null) {
                                maxprevdeffbset = true
                                var maxprevdeffb = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb
                                var maxprevdeffbmsg = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg
                            }

                        }
                    }

                    if (maxprevdeffbset) {
                        deffbxtra = "<maxprevdeffb>" + maxprevdeffb + "</maxprevdeffb><maxprevdeffbmsg>" + maxprevdeffbmsg + "</maxprevdeffbmsg>"
                        if (prevdeffb >= maxprevdeffb) {
                            deffbtxt = maxprevdeffbmsg
                            prevdeffb = 0
                        }
                    }

                    postBackResults(callbackq, user, { setvalue: "<text>" + deffbtxt + "</text><prevdeffb>" + prevdeffb + "</prevdeffb>" + deffbxtra }, originalreq, { slotname: "defaultfallback", nextactionp: "" });
                } else {
                    if (process.env.ERRORLOGGING == "TRUE") { console.log('something is off: No default fallback msg found'); }
                }

            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_deny: ' + e); }
        }
    }

    if (actionvars.action == "process_inform") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: process_inform'); }

            //sort events and find latest utterance
            var latestutterance = { name: "", timestamp: 0 };
            var latestbot = { text: "", timestamp: 0 }
            var latestuser = { text: "", timestamp: 0 };

            originalreq.tracker.events.forEach(ev => {
                if (ev.hasOwnProperty("name")) {
                    if (ev.name.slice(0, 6) == "utter_" && latestutterance.timestamp < ev.timestamp) {
                        //include all validation errors and answers here
                        if (ev.name != "utter_default_fallback" && ev.name != "utter_standardanswer" && ev.name != "utter_invalid_authcode" && ev.name != "utter_validation_email") {
                            latestutterance = ev
                        }
                    }
                }

                //latest user event
                if (ev.event == "user" && ev.metadata.hasOwnProperty("is_external") == false) {
                    if (latestuser.timestamp < ev.timestamp) {
                        latestuser = ev
                    }
                }

                //latest bot
                if (ev.event == "bot" && latestbot.timestamp < ev.timestamp) {
                    latestbot = ev
                }

            });

            //if client requests an update for the conversation, return latest db status
            var refreshPersistedConversation = false
            if (originalreq.tracker.slots.retrieved_conversation != null) {
                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: found persistedConversation '); }
                latestuser.parse_data.entities.forEach(ent => {

                    if (ent.entity == 'conversation_nonce') {
                        if (ent.value.slice(0, 1) != "[" && ent.value.slice(0, 1) != "{") {
                            refreshPersistedConversation = true
                            if (process.env.LOGGING == "TRUE") { console.log('Process_inform: refresh persistedConversation '); }
                        }
                    }
                })

            }

            if (originalreq.tracker.slots.retrieved_conversation == null || refreshPersistedConversation == true) {

                //determine next action

                //defaultvals
                actionvars.nextactionp = "instruct_utter_default_fallback"
                actionvars.slotname = ""
                query.setvalue = ""

                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: latest utterance is ' + latestutterance.name); }

                //check if latestusermessage includes affirm or deny.
                var affirmpickedup = false;
                var denypickedup = false;
                var candidatequestion = false;
                var answerfollowupquestionid = "";

                latestuser.parse_data.entities.forEach(ent => {
                    if (ent.entity == 'affirm') {
                        affirmpickedup = true
                    }

                    if (ent.entity == 'deny') {
                        denypickedup = true
                    }

                    if (ent.entity == 'candidatequestion') {
                        candidatequestion = true
                        if (process.env.LOGGING == "TRUE") { console.log('Process_inform: Candidatequestion found '); }
                    }
                });

                //check if user question has a standard answer
                var standardanswer = ""
                var standardanswerbuttons = ""
                var estimateanswer = ""
                var prevguessnr = "<prevguess>1</prevguess>"
                var estimatematch = false

                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference_answers != null && JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference_answers != "") {
                    if (process.env.LOGGING == "TRUE") { console.log('Process_inform: Standardanswers found '); }

                    //as long as NL:U is not sufficient to pick up candidatequestions, scan for questionmarks
                    if (candidatequestion == false) {
                        //if questionmark in response, its a candidatequestion
                        if (latestuser.text.match(/\?/gi) != null) {
                            candidatequestion = true;
                        }

                        //if responseisalwaysquestion flag on, its a candidatequestion
                        if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question != null) {
                            if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question != "") {

                                //treat response as question
                                if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.responseisalwaysquestion != null) {

                                    if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.responseisalwaysquestion == "true") {
                                        //reset flag to avoid conevrsation getting stuck
                                        var firstqforunsetalwaysqarray = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question
                                        firstqforunsetalwaysqarray.responseisalwaysquestion = "false"

                                        postBackResults(callbackq, user, { setvalue: firstqforunsetalwaysqarray }, originalreq, { slotname: "last_chatbot_application_question", nextactionp: "" });

                                        //candidatequestionflag
                                        candidatequestion = true;
                                    }
                                }

                                //save response as uservariable
                                if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.saveresponseasuservariable != null) {
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.saveresponseasuservariable == "true") {
                                        if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.uservariablename != null) {
                                            if (JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.uservariablename != "") {
                                                var uservariables = JSON.parse(JSON.parse(qmsg.data.msg).tracker.slots.uservariables)
                                                uservariables[JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question.uservariablename] = latestuser.text

                                                //update uservariables
                                                postBackResults(callbackq, user, { setvalue: JSON.stringify(uservariables) }, originalreq, { slotname: "uservariables", nextactionp: "" });
                                            }
                                        }
                                    }
                                }

                            }
                        }

                        //if latest bot utterance asks to ask another question, always treat an answer as
                        if (latestbot.text.includes("Sure, what would you like to ask?") || latestbot.text.includes("Natuurlijk! Wat is je vraag?") || latestbot.text.includes("Sure, could you phrase your original question a bit diferrent? That way, I might understand a bit better what you're asking") || latestbot.text.includes("Zeker! Kan je je originele vraag iets anders stellen? Dan begrijp ik je misschien beter")) {
                            candidatequestion = true;
                        }
                    }

                    if (candidatequestion) {
                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference_answers[0] != null) {

                            //standard next question answer

                            if (latestuser.text != "Can I ask another question?" && latestuser.text != "Mag ik nog iets vragen?" && latestuser.text != "Can I ask something different?" && latestuser.text != "Mag ik iets anders vragen?") {


                                var matchfound = false
                                var matchedkeywords = []
                                var estimatedmatches = []

                                JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference_answers.forEach(ans => {


                                    if (matchfound == false) {

                                        standardanswer = "I'm sorry, I dont know the answer to that question"
                                        standardanswerbuttons = "<buttons><button><title>Can I ask another question?</title><payload>Can I ask another question?</payload></button><button><title>I'd like to continue</title><payload>I'd like to continue</payload></button></buttons>"
                                        estimateanswer = "I'm sorry, I'm not sure of the answer to that question. Did you mean this?"

                                        //take language and nostandardanswer from chatbot if present
                                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].language == "NL") {
                                                    standardanswer = "Sorry, ik kan deze vraag niet beantwoorden"
                                                    standardanswerbuttons = "<buttons><button><title>Mag ik nog iets vragen?</title><payload>Mag ik nog iets vragen?</payload></button><button><title>Ik wil doorgaan</title><payload>Ik wil doorgaan</payload></button></buttons>"
                                                    estimateanswer = "Sorry, ik weet het antwoord op deze vraag niet zeker. Bedoel je dit?"
                                                }

                                                // if present, set custom answer
                                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].nostandardanswermsg != null) {
                                                    standardanswer = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].nostandardanswermsg
                                                }

                                                // if present, set custom answer
                                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].bestguessanswers != null) {
                                                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].bestguessanswers == 'true' && JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].bestguessanswersmsg != null) {
                                                        estimatematch = true

                                                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].bestguessanswersmsg != "") {
                                                            estimateanswer = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].bestguessanswersmsg
                                                        }
                                                    }

                                                }
                                            }
                                        }


                                    }


                                    ans.keywords.forEach(kw => {
                                        var comparequestion = " " + latestuser.text.replace(/\W/gi, " ").toUpperCase() + " "
                                        var comparekw = " " + kw.toUpperCase() + " "
                                        if (comparequestion.match(comparekw) != null) {
                                            if (process.env.LOGGING == "TRUE") { console.log('Process_inform: Match found with standard answer'); }
                                            standardanswer = ans.answer
                                            matchfound = true

                                            //if matched answer has a standard folowup question, set flag for posting fo both answer and followupquestion
                                            if (ans.followupquestionid != null) {
                                                answerfollowupquestionid = ans.followupquestionid
                                            }

                                            matchedkeywords.push(kw)
                                        } else {
                                            //if not match, see if estimate is needed, only if examplequestion is set
                                            if (estimatematch && ans.examplequestion != null) {
                                                estimatedmatches.push({ examplequestion: ans.examplequestion, matchpercentage: getJaroWrinkerStringSimilarityWeight(comparequestion, comparekw) })
                                            }
                                        }
                                    });
                                });

                                var anonymisedquestion = { timestamp: Date.now(), userid: JSON.parse(user).userid, userquestion: obfuscateEmailsInString(latestuser.text), chatliateanswer: standardanswer }

                                //copy info from chatbot
                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                        anonymisedquestion.tenantid = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid
                                        anonymisedquestion.email = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email
                                        anonymisedquestion.chatbotid = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid
                                        anonymisedquestion.language = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].language
                                    }
                                }

                                if (matchfound) {
                                    //save questionspecific matches to stats
                                    anonymisedquestion.matchedkeywordsquestion = []
                                    anonymisedquestion.matchedkeywordsconversation = []

                                    matchedkeywords.forEach(mkw => {
                                        anonymisedquestion.matchedkeywordsquestion.push(mkw)
                                        anonymisedquestion.matchedkeywordsconversation.push(mkw)
                                    });

                                    //store matched danswer keywords in conversation
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords != null) {
                                        if (JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords != "") {

                                            JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords.forEach(pmkw => {
                                                anonymisedquestion.matchedkeywordsconversation.push(pmkw)
                                            });


                                        }
                                    }

                                    postBackResults(callbackq, user, { setvalue: anonymisedquestion.matchedkeywordsconversation }, originalreq, { slotname: "matched_answer_keywords", nextactionp: "" });

                                    //save matched keywords on anonymisedquestion as well

                                } else {
                                    //if estimate is needed, give standard answer with likely matches
                                    if (estimatematch) {
                                        var sortedestimatedmatches = estimatedmatches.sort(function (a, b) { return b.matchpercentage - a.matchpercentage });

                                        //dedupe questions, highest matching keyword ofrom each question
                                        var emq = []
                                        var ddsem = []

                                        sortedestimatedmatches.forEach(sem => {
                                            if (emq.includes(sem.examplequestion) == false) {
                                                emq.push(sem.examplequestion)
                                                ddsem.push(sem)
                                            }
                                        });

                                        //max 4
                                        ddsem = ddsem.slice(0, 3)

                                        //generate buttons
                                        standardanswerbuttons = "<buttons>"

                                        //add
                                        ddsem.forEach(m => {
                                            estimateanswer = estimateanswer + "<br><br>" + m.examplequestion
                                            standardanswerbuttons = standardanswerbuttons + "<button><title>" + m.examplequestion + "</title><payload>" + m.examplequestion + "</payload></button>"
                                        });

                                        //set best guess answer
                                        standardanswer = estimateanswer

                                        //escape answer buttons
                                        var escapebuttons = "<button><title>Can I ask something different?</title><payload>Can I ask something different?</payload></button><button><title>I'd like to continue</title><payload>I'd like to continue</payload></button>"

                                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].language == "NL") {
                                                    escapebuttons = "<button><title>Mag ik iets anders vragen?</title><payload>Mag ik iets anders vragen?</payload></button><button><title>Ik wil doorgaan</title><payload>Ik wil doorgaan</payload></button>"
                                                }

                                                //if prevguesses max, show bestguessescapemsg, otherwise add to prevguessnr
                                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].maxbestguessnr != null) {
                                                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].maxbestguessnr != "") {
                                                        var currentbestguessnr = 1

                                                        //check if previous number found
                                                        if (JSON.parse(qmsg.data.msg).tracker.slots.standardanswer != null) {

                                                            if (JSON.parse(qmsg.data.msg).tracker.slots.standardanswer.match(/<prevguess.*>((.|\n)*?)<\/prevguess>/) != null) {

                                                                currentbestguessnr = Number(JSON.parse(qmsg.data.msg).tracker.slots.standardanswer.match(/<prevguess.*>((.|\n)*?)<\/prevguess>/)[1])
                                                            }
                                                        }

                                                        if (currentbestguessnr <= (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].maxbestguessnr)) {
                                                            //store updated prevuousbestguessnr in standardanswer
                                                            currentbestguessnr = currentbestguessnr + 1
                                                            prevguessnr = "<prevguess>" + currentbestguessnr + "</prevguess>"
                                                        } else {
                                                            //reset nr
                                                            prevguessnr = "<prevguess>1</prevguess>"

                                                            //remove found best guess answers
                                                            standardanswerbuttons = "<buttons>"

                                                            //set escape message
                                                            standardanswer = "I'm sorry, I can't seem to find an answer to your question. What would you like to do?"

                                                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].language == "NL") {
                                                                standardanswer = "Sorry, het lijkt er op dat ik geen antwoord voor je heb. Wat wil je doen?"
                                                            }

                                                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].maxbestguessnrmsg != null) {
                                                                standardanswer = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].maxbestguessnrmsg
                                                            }
                                                        }

                                                    }


                                                }

                                            }

                                        }

                                        standardanswerbuttons = standardanswerbuttons + escapebuttons + "</buttons>"


                                    }

                                    //if previous matches, store in stats
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords != null) {
                                        if (JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords != "") {

                                            anonymisedquestion.matchedkeywordsconversation = JSON.parse(qmsg.data.msg).tracker.slots.matched_answer_keywords

                                        }
                                    }
                                }

                                //wrap in text xml and concat with buttons
                                var answerbuttons = standardanswerbuttons

                                //skip buttopns if double postback
                                if (answerfollowupquestionid != "") {
                                    answerbuttons = ""
                                }

                                standardanswer = "<text>" + standardanswer + "</text>" + answerbuttons + prevguessnr

                                //store anonymisedquestion
                                anonymisedquestion.entity = "statsUserQuestion"
                                anonymisedquestion.action = "insert"

                                //post anonymised question to to stats DB
                                postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                    originalreq: originalreq,
                                    query: anonymisedquestion
                                })).catch(e => {
                                    console.error(e); process.exit(1)
                                });

                                //also store Chatliate answer as utterance
                                var statsusermatch = {
                                    entity: "statsUtterance",
                                    action: "insert",
                                    chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                    tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                    email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                    timestamp: Date.now(),
                                    type: 'standardAnswer',
                                    userid: JSON.parse(user).userid,
                                    prio: 2000,
                                    utterance: anonymisedquestion.chatliateanswer
                                }

                                //post match to to stats DB
                                postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                    originalreq: originalreq,
                                    query: statsusermatch
                                })).catch(e => {
                                    console.error(e); process.exit(1)
                                });

                            } else {
                                standardanswer = "<text>Sure, what would you like to ask?</text>"

                                //NL
                                if (latestuser.text == "Mag ik nog iets vragen?") {
                                    standardanswer = "<text>Natuurlijk! Wat is je vraag?</text>"
                                }

                                //different var for bestguess escape
                                if (latestuser.text == "Can I ask something different?") {
                                    standardanswer = "<text>Sure, could you phrase your original question a bit diferrent? That way, I might understand a bit better what you're asking</text>"
                                }

                                if (latestuser.text == "Mag ik iets anders vragen?") {
                                    standardanswer = "<text>Zeker! Kan je je originele vraag iets anders stellen? Dan begrijp ik je misschien beter</text>"
                                }

                                //pass on prevbestguess
                                if (JSON.parse(qmsg.data.msg).tracker.slots.standardanswer != null) {

                                    if (JSON.parse(qmsg.data.msg).tracker.slots.standardanswer.match(/<prevguess.*>((.|\n)*?)<\/prevguess>/) != null) {

                                        standardanswer = standardanswer + "<prevguess>" + JSON.parse(qmsg.data.msg).tracker.slots.standardanswer.match(/<prevguess.*>((.|\n)*?)<\/prevguess>/)[1] + "</prevguess>"
                                    }
                                }
                            }
                        }
                    }
                }
                if (candidatequestion == false) {
                    //in case of an unstricted previous utterance, skip to last block
                    var unscriptedutterance = true

                    if (latestutterance.name == "utter_next_chatbot_application_question") {

                        unscriptedutterance = false

                        //find uttered chatbot application question
                        var lastaskedq = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question

                        if (process.env.LOGGING == "TRUE") { console.log('Last asked chatbot appl question is ' + JSON.stringify(lastaskedq)); }

                        //check if latest user message has informed qualexes in it
                        var qualexpickedup = false

                        latestuser.parse_data.entities.forEach(ent => {
                            if (ent.entity == 'offered_qualex' || ent.entity == 'missing_qualex' || ent.entity == 'desfut_qualex' || ent.entity == 'searched_qualex') {
                                qualexpickedup = true
                            }
                        });

                        //If the last asked question is not a yes/no question, add to offered_qualex and move on to the next question. If last question is a yes/no question though, respond with the default "I dont understand"
                        if (lastaskedq.hasOwnProperty("affirmIntent") == false && lastaskedq.hasOwnProperty("denyIntent") == false) {
                            if (qualexpickedup == false) {
                                if (process.env.LOGGING == "TRUE") { console.log('last utterance was chatbot question. Splitting answer and saving as offered qualexes to avoid unrecognized qualexes by NLU'); }

                                var opql = []

                                //whole text especially for preset answers
                                opql.push(latestuser.text)

                                //split text in individual words andf add those as well
                                opql = opql.concat(latestuser.text.replace(/\W/gi, ' ').split(' '));

                                actionvars.slotname = "offered_qualex"
                                query.setvalue = opql
                            }

                            actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                        } else {
                            if (process.env.LOGGING == "TRUE") { console.log('Inform on question with affirm/deny intent'); }

                            var skipdefmsg = false

                            if (lastaskedq.hasOwnProperty("affirmIntent")) {
                                //Inform response on question with affirmIntent. If inform has the requested qualexes in the requested slotname, persist and continue as its likely been forwarded by the affirm action. If it doesnt have the requested qualexes in the requested slotname, check if there is an 'affirm' in the answer and add the requested qualexes in the specific slot.
                                if (process.env.LOGGING == "TRUE") { console.log('AffirmIntent found.'); }

                                var affirmqualexmatchfound = false
                                if (JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.affirmQualexSlotName] != null) {
                                    if (process.env.LOGGING == "TRUE") { console.log('Affirmqualexslotname found.'); }

                                    if (checkIfSingleMatch(lastaskedq.affirmQualex, JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.affirmQualexSlotName])) {
                                        if (process.env.LOGGING == "TRUE") { console.log('Matching qualex found in Affirmqualexslotname.'); }
                                        skipdefmsg = true
                                        affirmqualexmatchfound = true
                                        actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                                    }
                                }

                                if (lastaskedq.hasOwnProperty("affirmSkipCheckOnInform")) {
                                    //dont give back default message when affirmcheck can be skipped
                                    if (lastaskedq.affirmSkipCheckOnInform == 'true') {
                                        if (process.env.LOGGING == "TRUE") { console.log('Skipping affirmCheck on Inform. '); }
                                        skipdefmsg = true
                                        actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                                    }
                                }

                                if (affirmqualexmatchfound == false) {
                                    if (process.env.LOGGING == "TRUE") { console.log('No matching qualex found in Affirmqualexslotname. Storedqualex: ' + JSON.stringify(JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.affirmQualexSlotName]) + " Questionqualex: '" + lastaskedq.affirmQualex); }

                                    //persist found qualexes, but give default msg back
                                    actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_instruct_utter_default_fallback_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"

                                    //if affirm picked up, first add affirmqualexes before persisting qualexes
                                    if (affirmpickedup) {
                                        skipdefmsg = true
                                        if (process.env.LOGGING == "TRUE") { console.log('Affirm picked up'); }

                                        actionvars.nextactionp = "action_add_last_questions_affirmqualexes_sn__sdn__nap_action1_persist_qualexes_sn1_persisted_qualexes_sdn1__nap1_action11_set_matchpercentage_sn11_match_percentage_sdn11__nap11_action111_set_thank_you_for_applying_message_sn111_thank_you_for_applying_message_sdn111__nap111_action1111_rearrange_chatbot_application_questions_sn1111_retrieved_chatbot_application_questions_sdn1111__nap1111_action11111_set_next_chatbot_application_question_sn11111_next_chatbot_application_question_sdn11111__nap11111_action111111_store_last_application_question_sn111111_last_chatbot_application_question_sdn111111__nap111111_action1111111_remove_last_application_question_sn1111111_retrieved_chatbot_application_questions_sdn1111111__nap1111111_instruct_utter_next_chatbot_application_question_nan1111111__da1111111__la1111111_true_nan111111_instruct_utter_refer_back_da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_no_chatbot_application_questions_found_da11__la11_true_nan1__da1__la1_true_nan__da__la_true"
                                    }

                                }

                            }

                            if (lastaskedq.hasOwnProperty("denyIntent")) {
                                //Inform response on question with affirmIntent. If inform has the requested qualexes in the requested slotname, persist and continue as its likely been forwarded by the affirm action. If it doesnt have the requested qualexes in the requested slotname, check if there is an 'affirm' in the answer and add the requested qualexes in the specific slot.
                                if (process.env.LOGGING == "TRUE") { console.log('DenyIntent found.'); }

                                var denyqualexmatchfound = false
                                if (JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.denyQualexSlotName] != null) {
                                    if (process.env.LOGGING == "TRUE") { console.log('Denyqualexslotname found.'); }

                                    if (checkIfSingleMatch(lastaskedq.denyQualex, JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.denyQualexSlotName])) {
                                        if (process.env.LOGGING == "TRUE") { console.log('Matching qualex found in Denyqualexslotname.'); }
                                        denyqualexmatchfound = true
                                        actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                                    }
                                }

                                if (lastaskedq.hasOwnProperty("denySkipCheckOnInform")) {
                                    //dont give back default message when denycheck can be skipped
                                    if (lastaskedq.denySkipCheckOnInform == 'true') {
                                        if (process.env.LOGGING == "TRUE") { console.log('Skipping denyCheck on Inform. '); }
                                        skipdefmsg = true
                                        actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_action111_rearrange_chatbot_application_questions_sn111_retrieved_chatbot_application_questions_sdn111__nap111_action1111_set_next_chatbot_application_question_sn1111_next_chatbot_application_question_sdn1111__nap1111_action11111_store_last_application_question_sn11111_last_chatbot_application_question_sdn11111__nap11111_action111111_remove_last_application_question_sn111111_retrieved_chatbot_application_questions_sdn111111__nap111111_instruct_utter_next_chatbot_application_question_nan111111__da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                                    }
                                }

                                if (denyqualexmatchfound == false) {
                                    if (process.env.LOGGING == "TRUE") { console.log('No matching qualex found in Denyqualexslotname. Storedqualex: ' + JSON.stringify(JSON.parse(qmsg.data.msg).tracker.slots[lastaskedq.denyQualexSlotName]) + " Questionqualex: '" + lastaskedq.denyQualex); }

                                    //persist found qualexes, but give default msg back, unless deny was found
                                    if (skipdefmsg == false) {
                                        actionvars.nextactionp = "action_persist_qualexes_sn_persisted_qualexes_sdn__nap_action1_set_matchpercentage_sn1_match_percentage_sdn1__nap1_action11_set_thank_you_for_applying_message_sn11_thank_you_for_applying_message_sdn11__nap11_instruct_utter_default_fallback_nan11_instruct_utter_refer_back_da11__la11_true_nan1_instruct_utter_no_chatbot_application_questions_found_da1__la1_true_nan__da__la_true"
                                    }

                                    //if deny picked up, first add denyqualexes before persisting quualexes
                                    if (denypickedup) {
                                        if (process.env.LOGGING == "TRUE") { console.log('Deny picked up'); }

                                        actionvars.nextactionp = actionvars.nextactionp = "action_add_last_questions_denyqualexes_sn__sdn__nap_action1_persist_qualexes_sn1_persisted_qualexes_sdn1__nap1_action11_set_matchpercentage_sn11_match_percentage_sdn11__nap11_action111_set_thank_you_for_applying_message_sn111_thank_you_for_applying_message_sdn111__nap111_action1111_rearrange_chatbot_application_questions_sn1111_retrieved_chatbot_application_questions_sdn1111__nap1111_action11111_set_next_chatbot_application_question_sn11111_next_chatbot_application_question_sdn11111__nap11111_action111111_store_last_application_question_sn111111_last_chatbot_application_question_sdn111111__nap111111_action1111111_remove_last_application_question_sn1111111_retrieved_chatbot_application_questions_sdn1111111__nap1111111_instruct_utter_next_chatbot_application_question_nan1111111__da1111111__la1111111_true_nan111111_instruct_utter_refer_back_da111111__la111111_true_nan11111_instruct_utter_refer_back_da11111__la11111_true_nan1111_instruct_utter_refer_back_da1111__la1111_true_nan111_instruct_utter_refer_back_da111__la111_true_nan11_instruct_utter_no_chatbot_application_questions_found_da11__la11_true_nan1__da1__la1_true_nan__da__la_true"
                                    }

                                }

                            }
                        }
                    }

                    if (latestutterance.name == "utter_ask_chatbotsearch") {
                        unscriptedutterance = false
                        //in case inform and latest uterance was ask chatbotsearch, seach chatbots using the existing offeredqualex and the informed term

                        var searchedq = [originalreq.tracker.latest_message.text]

                        if (JSON.parse(qmsg.data.msg).tracker.slots.offered_qualex != null) {
                            searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.offered_qualex)
                        }

                        if (JSON.parse(qmsg.data.msg).tracker.slots.desfut_qualex != null) {
                            searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.desfut_qualex)
                        }

                        if (JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex != null) {
                            searchedq = searchedq.concat(JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex)
                        }

                        //if offered/desfut qualex mentioned
                        if (searchedq[0] != null) {
                            //search with parsed qualex
                            actionvars.nextactionp = "instruct_enquire_chatbot"
                            actionvars.slotname = "searched_qualex"
                            query.setvalue = searchedq
                        }
                    }

                    if (latestutterance.name == "utter_authcode_email") {
                        unscriptedutterance = false

                        if (originalreq.tracker.latest_message.text == JSON.parse(originalreq.tracker.slots.authcode).code) {


                            var chatbot = originalreq.tracker.slots.chatbot_reference[0]

                            if (chatbot != null) {

                                try {
                                    // candidate just applied for the first time. 

                                    //generate conversationnonces and link
                                    var cnjo = randomstring.generate({ length: 35, charset: 'numeric' })
                                    var cnca = randomstring.generate({ length: 35, charset: 'numeric' })
                                    var conversationlinkchatbotowner = "";
                                    var conversationlinkcandidate = "";

                                    var tenantsettings = {}

                                    if (chatbot.tenantsettings != null) {
                                        tenantsettings = chatbot.tenantsettings
                                    }

                                    if (chatbot.url != null) {
                                        conversationlinkchatbotowner = chatbot.url + "?chatbotid=" + chatbot.chatbotid + "&conversationnonce=" + cnjo + "&email=" + chatbot.email;
                                        conversationlinkcandidate = chatbot.url + "?chatbotid=" + chatbot.chatbotid + "&conversationnonce=" + cnca + "&email=" + JSON.parse(originalreq.tracker.slots.authcode).email;

                                        //format url to chatbotboard if present
                                        if (chatbot.chatbotboardurl != null) {
                                            conversationlinkchatbotowner = chatbot.chatbotboardurl + "?chatbotid=" + chatbot.chatbotid + "&conversationnonce=" + cnjo + "&email=" + chatbot.email;
                                            conversationlinkcandidate = chatbot.chatbotboardurl + "?chatbotid=" + chatbot.chatbotid + "&conversationnonce=" + cnca + "&email=" + JSON.parse(originalreq.tracker.slots.authcode).email;
                                        }
                                    }

                                    if (chatbot.continueoverdirectchat != null) {
                                        if (chatbot.continueoverdirectchat == "false") {
                                            if (chatbot.dashboardlink != null) {
                                                conversationlinkchatbotowner = chatbot.dashboardlink
                                            }

                                        }
                                    }

                                    //post new candidate comms to communicator
                                    postToCommunicatorQueue(user, JSON.stringify({ commstype: "newCandidateForChatbot", tracker: originalreq.tracker, tenantsettings: tenantsettings, receiverid: chatbot.email, chatbot: chatbot, match_percentage: originalreq.tracker.slots.match_percentage, messagesender: JSON.parse(originalreq.tracker.slots.authcode).email, conversationsubject: chatbot.title, conversationlink: conversationlinkchatbotowner, candidateemail: JSON.parse(originalreq.tracker.slots.authcode).email }))

                                    //copy candidate in
                                    postToCommunicatorQueue(user, JSON.stringify({ commstype: "conversationCopyApplicant", tracker: originalreq.tracker, tenantsettings: tenantsettings, receiverid: JSON.parse(originalreq.tracker.slots.authcode).email, chatbot: chatbot, match_percentage: originalreq.tracker.slots.match_percentage }))

                                    //persist chat for followup
                                    delete query.setvalue

                                    query.action = "insert"
                                    query.entity = "persistedConversation"
                                    query.conversationid = randomstring.generate({ length: 35, charset: 'numeric' })
                                    query.chatbotid = chatbot.chatbotid
                                    query.conversationsubject = chatbot.title

                                    if (chatbot.continueoverdirectchat != null) {
                                        query.continueoverdirectchat = chatbot.continueoverdirectchat
                                    }

                                    if (originalreq.tracker.slots.match_percentage != null) {
                                        query.match_percentage = originalreq.tracker.slots.match_percentage
                                    }

                                    if (originalreq.tracker.slots.matched_answer_keywords != null) {
                                        query.matched_answer_keywords = JSON.parse(originalreq.tracker.slots.matched_answer_keywords)
                                    }

                                    if (chatbot.tenantid != null) {
                                        query.tenantid = chatbot.tenantid

                                        if (chatbot.tenantsettings != null) {
                                            query.tenantsettings = chatbot.tenantsettings
                                        }
                                    }

                                    query.users = [{ language: chatbot.language, email: chatbot.email, conversationnonce: cnjo, type: "owner", conversationurl: conversationlinkchatbotowner }, { language: chatbot.language, email: JSON.parse(originalreq.tracker.slots.authcode).email, conversationnonce: cnca, type: "respondent", conversationurl: conversationlinkcandidate }]
                                    query.conversation = returnConversationAsObject(originalreq.tracker, chatbot.email, JSON.parse(originalreq.tracker.slots.authcode).email);

                                    //no need to store the persistedconversation in a slot
                                    actionvars.slotname = ""
                                } catch (e) {
                                    if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_inform_email:' + e); }
                                }

                            } else {
                                if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_inform_email: No chatbot set'); }
                            }

                            actionvars.nextactionp = "instruct_utter_application_forwarded"
                        } else {
                            actionvars.nextactionp = "instruct_utter_invalid_authcode"

                            var failedauth = parseInt(originalreq.tracker.slots.failedauth)
                            if (process.env.LOGGING == "TRUE") { console.log('Failed auth: Previous attempts: ' + failedauth); }

                            //check for number of failed validations. Over the limit, remove all application slots and tell user to start over
                            if (failedauth < 5) {
                                actionvars.slotname = "failedauth"
                                query.setvalue = failedauth + 1
                            } else {
                                actionvars.nextactionp = "instruct_utter_too_many_invalid_authcode"

                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "persisted_qualexes", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "persisted_benofs", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "all_retrieved_chatbot_application_questions", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "retrieved_chatbot_application_questions", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "next_chatbot_application_question", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "last_chatbot_application_question", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "match_percentage", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "informed_email", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "authcode", nextactionp: "" });
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "failedauth", nextactionp: "0" });
                            }


                        }
                    }

                    if (latestutterance.name == "utter_refer_back") {
                        unscriptedutterance = false

                        var chatbot = originalreq.tracker.slots.chatbot_reference[0]

                        if (chatbot != null) {
                            if (chatbot.directchat != null) {
                                actionvars.nextactionp = "instruct_utter_refer_back"

                                if (chatbot.directchat == 'true') {

                                    if (isValidEmail(originalreq.tracker.latest_message.text)) {
                                        var authcode = randomstring.generate({ length: 8, charset: 'numeric' })
                                        var tenantsettings = {}

                                        if (chatbot.tenantsettings != null) {
                                            tenantsettings = chatbot.tenantsettings
                                        }

                                        actionvars.slotname = "authcode"
                                        query.setvalue = JSON.stringify({ email: originalreq.tracker.latest_message.text, code: authcode })

                                        actionvars.nextactionp = "instruct_utter_authcode_email"

                                        //post auth email to communicator
                                        postToCommunicatorQueue(user, JSON.stringify({ commstype: "sendAuthCodeApplicant", tenantsettings: tenantsettings, tracker: originalreq.tracker, receiverid: originalreq.tracker.latest_message.text, chatbot: chatbot, authcode: authcode }))
                                    } else {
                                        actionvars.nextactionp = "instruct_utter_validation_email"
                                    }
                                }
                            }
                        } else {
                            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_inform_email: No chatbot set'); }
                        }


                    };

                    //everything else, make up the next action from the saved slots

                    if (unscriptedutterance) {

                        var chatbotapplication = false
                        var chatbotsearch = false
                        var qualexpickedup = []
                        var chatbot_reference = ""
                        var conversation_nonce = ""

                        //run through latest user message
                        latestuser.parse_data.entities.forEach(ent => {
                            if (ent.entity == 'chatbotapplication') {
                                chatbotapplication = true
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbotapplication found '); }
                            }

                            if (ent.entity == 'chatbotsearch') {
                                chatbotsearch = true
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbotsearch found '); }
                            }

                            if (ent.entity == 'chatbot_reference') {
                                if (ent.value.slice(0, 1) != "[" && ent.value.slice(0, 1) != "{") {
                                    chatbot_reference = ent.value
                                    if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot reference found '); }
                                }
                            }

                            if (ent.entity == 'conversation_nonce') {
                                if (ent.value.slice(0, 1) != "[" && ent.value.slice(0, 1) != "{") {
                                    conversation_nonce = ent.value
                                    if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. conversation_nonce found '); }
                                }
                            }

                            if (ent.entity == 'offered_qualex' || ent.entity == 'searched_qualex') {
                                qualexpickedup.push(ent.value)
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. qualex found '); }
                            }
                        });

                        if (chatbotapplication) {
                            if (chatbot_reference == "") {
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot application without a chatbot reference '); }
                                actionvars.nextactionp = "instruct_utter_choose_chatbot"
                            } else {
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot application with a chatbot reference '); }
                                actionvars.nextactionp = "instruct_apply_chatbot"
                            }

                        } else {
                            if (chatbotsearch) {
                                if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot search '); }
                                actionvars.nextactionp = "instruct_enquire_chatbot"

                                //remove chatbotid
                                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "chatbot_reference", nextactionp: "" });

                            } else {
                                if (chatbot_reference != "") {
                                    if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot reference without chatbotapplication'); }
                                    actionvars.nextactionp = "instruct_inform_chatbot"

                                    //if reference to existing conversation, set appropriate action
                                    if (conversation_nonce != "") {
                                        if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Chatbot reference without chatbotapplication. Conversation nonce found'); }
                                        actionvars.nextactionp = "instruct_inform_conversation"
                                    }

                                } else {
                                    //default to searching chatbots
                                    if (process.env.LOGGING == "TRUE") { console.log('Process_inform: unscripted utterance. Defaulting to search chatbots'); }

                                    //remove chatbotid
                                    postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "chatbot_reference", nextactionp: "" });

                                    actionvars.nextactionp = "instruct_utter_ask_find_chatbots_informed_qualex"
                                    actionvars.slotname = "searched_qualex"

                                    if (qualexpickedup[0] == null) {
                                        qualexpickedup = qualexpickedup.concat(latestuser.text.replace(/\W/gi, ' ').split(' '));
                                    }

                                    query.setvalue = qualexpickedup
                                }
                            }
                        }

                    }

                } else {
                    //answer postback

                    //set user vars in standardanswer
                    standardanswer = fillUservariablesInOutboundMessage(standardanswer,JSON.parse(qmsg.data.msg).tracker.slots.uservariables)

                    //single answer postback
                    if (process.env.LOGGING == "TRUE") { console.log('Standardanswer set '); }
                    actionvars.slotname = "standardanswer"
                    query.setvalue = standardanswer
                    actionvars.nextactionp = "instruct_utter_standardanswer"

                    if (answerfollowupquestionid != "" && answerfollowupquestionid != null) {
                        //answer and followup question postback
                        //find out if followupquestion has already been asked
                        var followupquestionfound = false
                        var newjq = []
                        if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions != null) {
                            if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0] != null) {
                                //rearrage chatbot questions, put the followupquestion first

                                JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions.forEach(rjq => {
                                    if (rjq.questionid == answerfollowupquestionid) {
                                        //add to the beginning
                                        rjq.donotask = "false"
                                        newjq.unshift(rjq)
                                        followupquestionfound = true
                                    } else {
                                        //add to the end
                                        newjq.push(rjq)
                                    }
                                });
                            }
                        }

                        //if alreday asked, or postback question not found, only post back the answer and add the standard butons back again.
                        if (followupquestionfound == false) {
                            //single answer postback
                            if (process.env.LOGGING == "TRUE") { console.log('Standardanswer set. No suitable followupquestion found '); }

                            //set answerbuttons back
                            query.setvalue = standardanswer + standardanswerbuttons

                        } else {
                            //if not alreday asked
                            //single answer postback
                            if (process.env.LOGGING == "TRUE") { console.log('Standardanswer and followupquestion postback. '); }

                            // first post back the answer without buttons
                            postBackResults(callbackq, user, query, originalreq, actionvars);

                            //then set the followupquetion for postback
                            // first save slot, then set next question
                            actionvars.slotname = "retrieved_chatbot_application_questions"
                            query.setvalue = newjq
                            actionvars.nextactionp = "action_set_next_chatbot_application_question_sn_next_chatbot_application_question_sdn__nap_action1_store_last_application_question_sn1_last_chatbot_application_question_sdn1__nap1_action11_remove_last_application_question_sn11_retrieved_chatbot_application_questions_sdn11__nap11_instruct_utter_next_chatbot_application_question_nan11__da11__la11_true_nan1_instruct_utter_refer_back_da1__la1_true_nan_instruct_utter_refer_back_da__la_true"

                        }

                    }

                }

            } else {

                actionvars.nextactionp = "instruct_utter_ack"
                actionvars.slotname = ""

                var convid = originalreq.tracker.slots.retrieved_conversation.match(/<id.*>((.|\n)*?)<\/id>/)[1]
                var conversationsubject = "No subject"
                var tenantsettings = {}

                if (originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/) != null) {
                    conversationsubject = originalreq.tracker.slots.retrieved_conversation.match(/<conversationsubject.*>((.|\n)*?)<\/conversationsubject>/)[1]
                }

                if (originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/) != null) {
                    tenantsettings = JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<tenantsettings.*>((.|\n)*?)<\/tenantsettings>/)[1]))
                }


                query.action = "updatepush"
                query.entity = "persistedConversation"
                query._id = convid

                query.updatepushquerynewvalues = { "conversation": { timestamp: Date.now(), user: originalreq.tracker.slots.conversation_email, text: originalreq.tracker.latest_message.text, chatliateresponse: "false" } }

                JSON.parse(decodeURIComponent(originalreq.tracker.slots.retrieved_conversation.match(/<users.*>((.|\n)*?)<\/users>/)[1])).forEach(usr => {

                    //dont send to the poster of the message
                    if (usr.email != originalreq.tracker.slots.conversation_email) {
                        //post new message comms to communicator
                        postToCommunicatorQueue(user, JSON.stringify({ commstype: "newMessagePersistedChat", tracker: originalreq.tracker, receiverid: usr.email, user: usr, messagesender: originalreq.tracker.slots.conversation_email, tenantsettings: tenantsettings, conversationsubject: conversationsubject, conversationid: convid }))
                    } else {
                        //cancel messages due outbound for this conversation to responding user, as he's already active
                        postToCommunicatorQueue(user, JSON.stringify({ commstype: "cancelMessagesForUserConversation", tracker: originalreq.tracker, tenantsettings: tenantsettings, receiverid: usr.email, user: usr, conversationid: convid }))
                    }

                });
            }

            //update default msg, if nextaction
            if (actionvars.nextactionp == "instruct_utter_default_fallback") {
                if (originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/) != null) {
                    var prevdeffb = 0

                    if (originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/) != null) {
                        prevdeffb = Number(originalreq.tracker.slots.defaultfallback.match(/<prevdeffb.*>((.|\n)*?)<\/prevdeffb>/)[1])
                    }

                    prevdeffb++

                    var deffbtxt = originalreq.tracker.slots.defaultfallback.match(/<text.*>((.|\n)*?)<\/text>/)[1]
                    var deffbxtra = ""
                    var maxprevdeffbset = false

                    if (originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/) != null && originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/) != null) {
                        maxprevdeffbset = true
                        var maxprevdeffb = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffb.*>((.|\n)*?)<\/maxprevdeffb>/)[1]
                        var maxprevdeffbmsg = originalreq.tracker.slots.defaultfallback.match(/<maxprevdeffbmsg.*>((.|\n)*?)<\/maxprevdeffbmsg>/)[1]
                    }

                    //chatbot always overrules
                    if (originalreq.tracker.slots.chatbot_reference != null) {
                        if (originalreq.tracker.slots.chatbot_reference[0] != null) {
                            if (originalreq.tracker.slots.chatbot_reference[0].deffbmsg != null) {
                                deffbtxt = originalreq.tracker.slots.chatbot_reference[0].deffbmsg
                            }

                            if (originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb != null && originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg != null) {
                                maxprevdeffbset = true
                                var maxprevdeffb = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffb
                                var maxprevdeffbmsg = originalreq.tracker.slots.chatbot_reference[0].maxprevdeffbmsg
                            }

                        }
                    }

                    if (maxprevdeffbset) {
                        deffbxtra = "<maxprevdeffb>" + maxprevdeffb + "</maxprevdeffb><maxprevdeffbmsg>" + maxprevdeffbmsg + "</maxprevdeffbmsg>"
                        if (prevdeffb >= maxprevdeffb) {
                            deffbtxt = maxprevdeffbmsg
                            prevdeffb = 0
                        }
                    }

                    postBackResults(callbackq, user, { setvalue: "<text>" + deffbtxt + "</text><prevdeffb>" + prevdeffb + "</prevdeffb>" + deffbxtra }, originalreq, { slotname: "defaultfallback", nextactionp: "" });
                } else {
                    if (process.env.ERRORLOGGING == "TRUE") { console.log('something is off: No default fallback msg found'); }
                }

            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at process_inform: ' + e); }
        }
    }

    if (actionvars.action == "add_last_questions_affirmqualexes") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: add_last_questions_affirmqualexes'); }

            //find uttered chatbot application question
            var lastaskedq = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question

            actionvars.slotname = lastaskedq.affirmQualexSlotName
            query.setvalue = lastaskedq.affirmQualex

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at add_last_questions_affirmqualexes: ' + e); }
        }
    }

    if (actionvars.action == "add_last_questions_denyqualexes") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: add_last_questions_denyqualexes'); }

            //find uttered chatbot application question
            var lastaskedq = JSON.parse(qmsg.data.msg).tracker.slots.last_chatbot_application_question

            actionvars.slotname = lastaskedq.denyQualexSlotName
            query.setvalue = lastaskedq.denyQualex

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at add_last_questions_denyqualexes: ' + e); }
        }
    }

    if (actionvars.action == "persist_qualexes") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: persist qualex. '); }

            var dpql = JSON.parse(qmsg.data.msg).tracker.slots.desfut_qualex
            var opql = JSON.parse(qmsg.data.msg).tracker.slots.offered_qualex
            var mpql = JSON.parse(qmsg.data.msg).tracker.slots.missing_qualex

            var existingpq = JSON.parse(qmsg.data.msg).tracker.slots.persisted_qualexes;

            //check for unrecognized qualexes by NLu in case of chatbotquestions
            //sort events and find latest utterance with exception of validation
            var latestutterance = { name: "", timestamp: 0 };
            var latestuser = { text: "", timestamp: 0 };

            originalreq.tracker.events.forEach(ev => {
                if (ev.hasOwnProperty("name")) {
                    if (ev.name.slice(0, 6) == "utter_" && latestutterance.timestamp < ev.timestamp) {
                        if (ev.name != "utter_default_fallback" && ev.name != "utter_standardanswer") {
                            latestutterance = ev
                        }
                    }
                }

                //latest user event
                if (ev.event == "user" && ev.metadata.hasOwnProperty("is_external") == false) {
                    if (latestuser.timestamp < ev.timestamp) {
                        latestuser = ev
                    }
                }
            });

            if (latestutterance.name == "utter_next_chatbot_application_question") {
                //if no entities were extracted from the user answer, chop up the whole answer and save as offered qualex to avoid unrecognised qualexes

                if (opql == null) {
                    opql = []
                }

                //also add the whole user response to offeredqualex, for matching wildcards
                opql.push(latestuser.text)

                var qualexpickedup = false

                latestuser.parse_data.entities.forEach(ent => {
                    if (ent.entity == 'offered_qualex' || ent.entity == 'missing_qualex' || ent.entity == 'desfut_qualex') {
                        qualexpickedup = true
                    }
                });

                if (qualexpickedup == false) {
                    if (process.env.LOGGING == "TRUE") { console.log('last utterance was chatbot question. Splitting answer and saving as offered qualexes to avoid unrecognized qualexes by NLU'); }
                    opql = opql.concat(latestuser.text.replace(/\W/gi, ' ').split(' '));
                }

            }

            //initiate slot
            if (existingpq == null || existingpq == "") {
                existingpq = JSON.stringify({ desfut_qualex: [], offered_qualex: [], missing_qualex: [] });
            }


            if (dpql != null || opql != null || mpql != null) {
                if (process.env.LOGGING == "TRUE") { console.log('found qualexes to persist'); }

                //transform into object
                existingpq = JSON.parse(existingpq);

                if (process.env.LOGGING == "TRUE") { console.log('parsed persisted qualexes'); }

                //desfut qualex
                if (dpql = null) {
                    if (process.env.LOGGING == "TRUE") { console.log('adding desfut qualexes to persist'); }
                    //add desfut qualexes to persisted list
                    dpql.forEach(pq => {
                        if (Array.isArray(pq) == false) {
                            pq = pq.toUpperCase().trim();
                        }

                        var dpqlexists = false

                        existingpq.desfut_qualex.forEach(dqex => {
                            dqex = dqex.toUpperCase().trim();

                            if (dqex == pq) {
                                dpqlexists = true
                            }
                        });

                        if (dpqlexists == false) {
                            existingpq.desfut_qualex.push(pq);
                        }

                    });
                }

                //missing qualex
                if (mpql != null) {
                    if (process.env.LOGGING == "TRUE") { console.log('adding missing qualexes to persist'); }
                    //add desfut qualexes to persisted list
                    mpql.forEach(pq => {
                        if (Array.isArray(pq) == false) {
                            pq = pq.toUpperCase().trim();
                        }
                        var mpqlexists = false

                        existingpq.missing_qualex.forEach(mqex => {
                            mqex = mqex.toUpperCase().trim();

                            if (mqex == pq) {
                                mpqlexists = true
                            }
                        });

                        if (mpqlexists == false) {
                            existingpq.missing_qualex.push(pq);
                        }
                    });
                }

                //offered qualex
                if (opql != null) {
                    if (process.env.LOGGING == "TRUE") { console.log('adding offered qualexes to persist: ' + JSON.stringify(opql)); }
                    //add desfut qualexes to persisted list
                    opql.forEach(pq => {
                        if (Array.isArray(pq) == false) {
                            pq = pq.toUpperCase().trim();
                        }

                        var opqlexists = false

                        existingpq.offered_qualex.forEach(oqex => {
                            if (Array.isArray(oqex) == false) {
                                oqex = oqex.toUpperCase().trim();
                            }

                            if (oqex == pq) {
                                opqlexists = true
                            }
                        });

                        if (opqlexists == false) {
                            existingpq.offered_qualex.push(pq);
                        }
                    });
                }


                query.setvalue = JSON.stringify(existingpq);

            } else {
                if (process.env.LOGGING == "TRUE") { console.log('found no qualexes to persist.'); }

                query.setvalue = existingpq;

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at persist_qualexes: ' + e); }
        }
    }

    if (actionvars.action == "retrieve_conversation") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: action_retrieve_conversation'); }
            //find 

            query.entity = "persistedConversation";

            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null && JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != "" && JSON.parse(qmsg.data.msg).tracker.slots.conversation_nonce != null && JSON.parse(qmsg.data.msg).tracker.slots.conversation_nonce != "" && JSON.parse(qmsg.data.msg).tracker.slots.conversation_email != null && JSON.parse(qmsg.data.msg).tracker.slots.conversation_email != "") {
                query.chatbotid = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference;
                query.users = { $elemMatch: { email: JSON.parse(qmsg.data.msg).tracker.slots.conversation_email, conversationnonce: JSON.parse(qmsg.data.msg).tracker.slots.conversation_nonce } }

                //if user has tenantid, only show conversations associated with that tenantid
                if (JSON.parse(user).tenantid != null) {
                    query.tenantid = JSON.parse(user).tenantid
                }
            } else {
                if (process.env.ERRORLOGGING == "TRUE") { console.log('error at retrieve_conversation: missing chatbot reference, conversationnonce or email'); }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at retrieve_chatbots: ' + e); }
        }
    }

    if (actionvars.action == "retrieve_chatbots") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: action_retrieve_chatbots'); }
            //find 

            query.entity = "chatbot";

            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null && JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != "") {
                query.chatbotid = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference;

                //also retrieve standard answers at this point
                postBackResults(callbackq, user, { entity: "answer", chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference }, originalreq, { slotname: "chatbot_reference_answers", nextactionp: "" });
            } else {
                //if not looking for a specific chatbot, only show the chatbots with the 'open' status
                query.chatbotstatus = "open"
            }

            if (JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex != null && JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex != "") {

                //search aggregate pipeline. Start with Chatbotapplquestion, lookup chatbots, then make those distinct
                query.action = "aggregate"
                query.entity = "question"
                query.aggregate = [
                    {
                        $match: {
                            requestedQualex: {
                                $in: JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex.map(a => a.toUpperCase())
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "chatbot",
                            localField: "chatbotid",
                            foreignField: "chatbotid",
                            as: "chatbot"
                        }
                    },
                    {
                        $unwind: {
                            path: "$chatbot"
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            chatbot: 1
                        }
                    },
                    {
                        $replaceRoot: {
                            newRoot: {
                                $mergeObjects: [
                                    { _id: "$_id", chatbotid: "" }, "$chatbot"
                                ]
                            }
                        }
                    },
                    {
                        $group: {
                            _id: "$_id",
                            doc: {
                                $first: "$$ROOT"
                            }
                        }
                    },
                    {
                        $replaceRoot: {
                            newRoot: "$doc"
                        }
                    }

                ]

            }

            //if user has tenantid, only show chatbots associated with that tenantid
            if (JSON.parse(user).tenantid != null) {
                query.tenantid = JSON.parse(user).tenantid
            }

            //if user has language set, only show chatbots associated in that language
            if (JSON.parse(user).language != null) {
                query.language = JSON.parse(user).language
            }

            //clear searchedqualex
            if (JSON.parse(qmsg.data.msg).tracker.slots.searched_qualex != null) {
                postBackResults(callbackq, user, { setvalue: "" }, originalreq, { slotname: "searched_qualex", nextactionp: "" });
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at retrieve_chatbots: ' + e); }
        }
    }

    if (actionvars.action == "retrieve_chatbot_application_questions") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: retrieve_chatbot_application_questions'); }

            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null && JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != "") {
                query.entity = "question";

                //sort by prio, then by id
                query.sort = { prio: 1, _id: 1 }

                if (process.env.LOGGING == "TRUE") { console.log('next action: retrieve_chatbot_application_questions. Chatbot reference is ' + JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference); }
                query.chatbotid = JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid;
            } else {
                if (process.env.LOGGING == "TRUE") { console.log('no chatbotid set'); }

                query.setvalue = "";

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at retrieve_chatbot_application_questionss: ' + e); }
        }

    }

    if (actionvars.action == "rearrange_chatbot_application_questions") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: rearrange_chatbot_application_questions'); }

            //This action checks 2 things: It checks if the question should not be uttered because it was matched to either a offered or a missing qualex, and secondly it determines whether it refere to either a missing or a offered qualex, so it needs to be asked earlier. 


            if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0] != null) {
                if (process.env.LOGGING == "TRUE") { console.log('rearranging questions.'); }

                var existinglist = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions;
                var askfirst = [];
                var asklater = [];
                var askmaybe = [];

                var perqualex = JSON.parse(qmsg.data.msg).tracker.slots.persisted_qualexes;
                var slotofferedqualex = JSON.parse(perqualex).offered_qualex
                var slotmissingqualex = JSON.parse(perqualex).missing_qualex;
                var allcollectedqualex = [];

                if (slotofferedqualex == null) {
                    if (slotmissingqualex != null) {
                        allcollectedqualex = slotmissingqualex;
                    }
                } else {
                    if (slotmissingqualex == null) {
                        allcollectedqualex = slotofferedqualex;
                    } else {
                        allcollectedqualex = slotofferedqualex.concat(slotmissingqualex)
                    }
                }



                if (process.env.LOGGING == "TRUE") { console.log('looping through questions'); }

                existinglist.forEach(lq => {

                    //first check if the question does not need to be uttered anymore
                    if (checkMatchDoNotUtter(lq, allcollectedqualex) == false) {

                        //if both referredOffered and collected slots and referredMissing and collected slots are empty, add question to askmaybe or asklater list. No second check is needed
                        if ((lq.referredOfferedQualex != null && slotofferedqualex != null) || (lq.referredMissingQualex != null && slotmissingqualex != null)) {
                            if (process.env.LOGGING == "TRUE") { console.log('referred and collected qualex set. Evaluating whether there is a match ' + lq.questionid); }
                            //don't add twice
                            var addfirst = false;

                            if (lq.referredOfferedQualex != null && slotofferedqualex != null) {
                                if (checkIfSingleMatch(lq.referredOfferedQualex, slotofferedqualex)) {
                                    if (process.env.LOGGING == "TRUE") { console.log('Match found between referredOffered and Offered qualex. Adding to askfirst list. Id: ' + lq.questionid); }
                                    addfirst = true;
                                }
                            }

                            if (lq.referredMissingQualex != null && slotmissingqualex != null) {
                                if (checkIfSingleMatch(lq.referredMissingQualex, slotmissingqualex)) {
                                    if (process.env.LOGGING == "TRUE") { console.log('Match found between referredMissing and Missing qualex. Adding to askfirst list. Id: ' + lq.questionid); }
                                    addfirst = true;
                                }
                            }

                            //if either offered or missing match, add to addfirst
                            if (addfirst) {
                                //if match, ask first and remove donotask flag
                                lq.donotask = "false";
                                askfirst.push(lq);
                            } else {
                                //if no match, ask maybe and set donotask flag
                                lq.donotask = "true";
                                askmaybe.push(lq);
                                if (process.env.LOGGING == "TRUE") { console.log('No Match found between referred and collected qualex. Adding to askmaybe list. Id: ' + lq.questionid); }
                            }

                        } else {
                            if (lq.referredOfferedQualex != null || lq.referredMissingQualex != null) {
                                lq.donotask = "true";
                                askmaybe.push(lq);
                                if (process.env.LOGGING == "TRUE") { console.log('No qualex collected so far. Adding to askmaybe list. Id: ' + lq.questionid); }
                            } else {
                                if (process.env.LOGGING == "TRUE") { console.log('No referredOffered or referredMissing are set on question. Adding to asklater list. Id: ' + lq.questionid); }
                                asklater.push(lq);
                            }
                        }

                    } else {
                        if (process.env.LOGGING == "TRUE") { console.log('Skipping question as it was already matched to either a missing or offered qualex. Id: ' + lq.questionid); }
                    }

                });
                //sort all 3 lists by prio
                askfirst.sort(function (a, b) { return parseInt(a.prio) - parseInt(b.prio) });
                asklater.sort(function (a, b) { return parseInt(a.prio) - parseInt(b.prio) });
                askmaybe.sort(function (a, b) { return parseInt(a.prio) - parseInt(b.prio) });

                //return list by concatenating the askfirst and asklater lists
                var newlist = askfirst.concat(asklater, askmaybe);

                query.setvalue = newlist;

            } else {
                if (process.env.LOGGING == "TRUE") { console.log('no questions found'); }

                //End of conversation. store matched qualexes to stats db
                //store matches to stats db

                if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != null) {
                    if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != "") {
                        if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex != null) {
                            var matchqualexarr = JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex

                            matchqualexarr.forEach(mq => {
                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                        var statsquery = {
                                            entity: "statsUserMatch",
                                            action: "insert",
                                            chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                            tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                            email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                            timestamp: Date.now(),
                                            match: mq,
                                            userid: JSON.parse(decodeURIComponent(user)).userid,
                                            type: "offeredQualex"
                                        }

                                        //post match to to stats DB
                                        postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                            originalreq: originalreq,
                                            query: statsquery
                                        })).catch(e => {
                                            console.error(e); process.exit(1)
                                        });
                                    }

                                }
                            });
                        }
                    }
                }

                //store new question to be uttered to stats db
                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {

                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {

                        var statsusermatch = {
                            entity: "statsUtterance",
                            action: "insert",
                            chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                            tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                            email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                            timestamp: Date.now(),
                            type: 'standardQuestion',
                            userid: JSON.parse(decodeURIComponent(user)).userid,
                            utterance: "No more questions",
                            prio: 1000
                        }

                        //post match to to stats DB
                        postToInboundStatsDbRequestQueue(user, JSON.stringify({
                            originalreq: originalreq,
                            query: statsusermatch
                        })).catch(e => {
                            console.error(e); process.exit(1)
                        });
                    }
                }


                query.setvalue = "";

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at rearrange_chatbot_application_questions: ' + e); }
        }
    }

    if (actionvars.action == "set_next_chatbot_application_question") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: set_next_chatbot_application_question'); }

            if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0] != null) {

                //only set next question if it can be asked
                if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0].donotask != null) {

                    if (JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0].donotask != "true") {
                        if (process.env.LOGGING == "TRUE") { console.log('setting next question 1'); }

                        var naq = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0]
                        query.setvalue = "<text>" + fillUservariablesInOutboundMessage(naq.question,JSON.parse(qmsg.data.msg).tracker.slots.usersettings) + "</text>";

                        //check if presetanswers set on question
                        if (naq.presetanswers != null) {
                            query.setvalue = query.setvalue + "<buttons>"

                            naq.presetanswers.forEach(qpa => {
                                query.setvalue = query.setvalue + "<button><title>" + qpa.title + "</title><payload>" + qpa.payload + "</payload></button>"
                            });

                            query.setvalue = query.setvalue + "</buttons>"
                        }

                        //store new question to be uttered to stats db

                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {

                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {

                                var statsusermatch = {
                                    entity: "statsUtterance",
                                    action: "insert",
                                    chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                    tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                    email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                    timestamp: Date.now(),
                                    type: 'standardQuestion',
                                    userid: JSON.parse(decodeURIComponent(user)).userid,
                                    prio: parseInt(naq.prio),
                                    utterance: naq.question
                                }

                                //post match to to stats DB
                                postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                    originalreq: originalreq,
                                    query: statsusermatch
                                })).catch(e => {
                                    console.error(e); process.exit(1)
                                });
                            }
                        }


                    } else {
                        if (process.env.LOGGING == "TRUE") { console.log('no next question found that is suitable to be asked'); }


                        //End of conversation. store matched qualexes to stats db
                        //store matches to stats db

                        if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != null) {
                            if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != "") {
                                if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex != null) {
                                    var matchqualexarr = JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex

                                    matchqualexarr.forEach(mq => {
                                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                                var statsquery = {
                                                    entity: "statsUserMatch",
                                                    action: "insert",
                                                    chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                                    tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                                    email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                                    timestamp: Date.now(),
                                                    match: mq,
                                                    userid: JSON.parse(decodeURIComponent(user)).userid,
                                                    type: "offeredQualex"
                                                }

                                                //post match to to stats DB
                                                postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                                    originalreq: originalreq,
                                                    query: statsquery
                                                })).catch(e => {
                                                    console.error(e); process.exit(1)
                                                });
                                            }

                                        }
                                    });
                                }
                            }
                        }

                        //store new question to be uttered to stats db
                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {

                            if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {

                                var statsusermatch = {
                                    entity: "statsUtterance",
                                    action: "insert",
                                    chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                    tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                    email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                    timestamp: Date.now(),
                                    type: 'standardQuestion',
                                    userid: JSON.parse(decodeURIComponent(user)).userid,
                                    utterance: "No more questions",
                                    prio: 1000
                                }

                                //post match to to stats DB
                                postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                    originalreq: originalreq,
                                    query: statsusermatch
                                })).catch(e => {
                                    console.error(e); process.exit(1)
                                });
                            }
                        }

                        query.setvalue = "";

                        if (actionvars.nextactionn != "") {
                            actionvars.nextactionp = actionvars.nextactionn;
                        }
                    }

                } else {
                    if (process.env.LOGGING == "TRUE") { console.log('setting next question 2'); }

                    var naq = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions[0]
                    query.setvalue = "<text>" + fillUservariablesInOutboundMessage(naq.question,JSON.parse(qmsg.data.msg).tracker.slots.usersettings) + "</text>";

                    //check if presetanswers set on question
                    if (naq.presetanswers != null) {
                        query.setvalue = query.setvalue + "<buttons>"

                        naq.presetanswers.forEach(qpa => {
                            query.setvalue = query.setvalue + "<button><title>" + qpa.title + "</title><payload>" + qpa.payload + "</payload></button>"
                        });

                        query.setvalue = query.setvalue + "</buttons>"
                    }


                    //store new question to be uttered to stats db

                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {

                        if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {

                            var statsusermatch = {
                                entity: "statsUtterance",
                                action: "insert",
                                chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                timestamp: Date.now(),
                                type: 'standardQuestion',
                                userid: JSON.parse(decodeURIComponent(user)).userid,
                                utterance: naq.question,
                                prio: parseInt(naq.prio)
                            }

                            //post match to to stats DB
                            postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                originalreq: originalreq,
                                query: statsusermatch
                            })).catch(e => {
                                console.error(e); process.exit(1)
                            });
                        }
                    }

                }

            } else {
                if (process.env.LOGGING == "TRUE") { console.log('no next question found'); }

                //End of conversation. store matched qualexes to stats db
                //store matches to stats db

                if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != null) {
                    if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage != "") {
                        if (JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex != null) {
                            var matchqualexarr = JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex

                            matchqualexarr.forEach(mq => {
                                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {
                                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {
                                        var statsquery = {
                                            entity: "statsUserMatch",
                                            action: "insert",
                                            chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                                            tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                                            email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                                            timestamp: Date.now(),
                                            match: mq,
                                            userid: JSON.parse(decodeURIComponent(user)).userid,
                                            type: "offeredQualex"
                                        }

                                        //post match to to stats DB
                                        postToInboundStatsDbRequestQueue(user, JSON.stringify({
                                            originalreq: originalreq,
                                            query: statsquery
                                        })).catch(e => {
                                            console.error(e); process.exit(1)
                                        });
                                    }

                                }
                            });
                        }
                    }
                }

                //store new question to be uttered to stats db
                if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference != null) {

                    if (JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0] != null) {

                        var statsusermatch = {
                            entity: "statsUtterance",
                            action: "insert",
                            chatbotid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].chatbotid,
                            tenantid: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].tenantid,
                            email: JSON.parse(qmsg.data.msg).tracker.slots.chatbot_reference[0].email,
                            timestamp: Date.now(),
                            type: 'standardQuestion',
                            userid: JSON.parse(decodeURIComponent(user)).userid,
                            utterance: "No more questions",
                            prio: 1000
                        }

                        //post match to to stats DB
                        postToInboundStatsDbRequestQueue(user, JSON.stringify({
                            originalreq: originalreq,
                            query: statsusermatch
                        })).catch(e => {
                            console.error(e); process.exit(1)
                        });
                    }
                }

                query.setvalue = "";

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at set_next_chatbot_application_question: ' + e); }
        }
    }

    if (actionvars.action == "store_last_application_question") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: store_last_application_question'); }
            var rjaq = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions

            if (rjaq[0] != null) {
                if (process.env.LOGGING == "TRUE") { console.log('found question'); }

                var lastq = rjaq[0]

                query.setvalue = lastq;

            } else {
                query.setvalue = [];

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at store_last_application_question: ' + e); }
        }
    }

    if (actionvars.action == "remove_last_application_question") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: remove_last_application_question'); }
            var rjaq = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions

            if (rjaq[0] != null) {
                if (process.env.LOGGING == "TRUE") { console.log('found questions'); }

                var existinglist = JSON.parse(qmsg.data.msg).tracker.slots.retrieved_chatbot_application_questions;

                existinglist.shift();

                query.setvalue = existinglist;

            } else {
                query.setvalue = [];

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at remove_last_application_question: ' + e); }
        }
    }

    if (actionvars.action == "set_thank_you_for_applying_message") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: set_thank_you_for_applying_message'); }

            query.setvalue = "<text>Thank you for applying. You're matching the chatbot for " + JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.percentage + " percent. If you like me to consider your application, please leave your email address</text>";

            if (originalreq.tracker.slots.chatbot_reference[0] != null) {
                if (originalreq.tracker.slots.chatbot_reference[0].language == "NL") {
                    query.setvalue = "<text>Bedankt voor het solliciteren. Je matcht voor " + JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.percentage + " procent met de vacature. Als je wil dat we je sollicitatie in behandeling nemen, geef me dan je emailadres.</text>"
                }

                if (originalreq.tracker.slots.chatbot_reference[0].tymsg != null) {
                    query.setvalue = "<text>" + fillUservariablesInOutboundMessage(originalreq.tracker.slots.chatbot_reference[0].tymsg.replace(/<availablepoints>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.totalqualexpoints).replace(/<matchedpoints>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchqualexpoints).replace(/<percentage>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.percentage).replace(/<matchedlist>/gi, JSON.stringify(JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex)),JSON.parse(qmsg.data.msg).tracker.slots.uservariables) + "</text>"

                    //special tymsg if threshold is set
                    if (originalreq.tracker.slots.chatbot_reference[0].usepointsthreshold != null && originalreq.tracker.slots.chatbot_reference[0].pointsthreshold != null && originalreq.tracker.slots.chatbot_reference[0].tymsgbelowpointsthreshold != null) {
                        if (originalreq.tracker.slots.chatbot_reference[0].usepointsthreshold == 'true' && originalreq.tracker.slots.chatbot_reference[0].pointsthreshold >= JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchqualexpoints) {
                            query.setvalue = "<text>" + fillUservariablesInOutboundMessage(originalreq.tracker.slots.chatbot_reference[0].tymsgbelowpointsthreshold.replace(/<availablepoints>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.totalqualexpoints).replace(/<matchedpoints>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchqualexpoints).replace(/<percentage>/gi, JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.percentage).replace(/<matchedlist>/gi, JSON.stringify(JSON.parse(qmsg.data.msg).tracker.slots.match_percentage.matchedqualex)),JSON.parse(qmsg.data.msg).tracker.slots.uservariables) + "</text>"
                        }
                    }
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at set_thank_you_for_applying_message: ' + e); }
        }
    }

    if (actionvars.action == "set_matchpercentage") {
        try {
            if (process.env.LOGGING == "TRUE") { console.log('next action: set_matchpercentage'); }

            if (JSON.parse(qmsg.data.msg).tracker.slots.all_retrieved_chatbot_application_questions[0] != null) {
                if (process.env.LOGGING == "TRUE") { console.log('found all questions for percentage calculation'); }

                var alllist = JSON.parse(qmsg.data.msg).tracker.slots.all_retrieved_chatbot_application_questions;

                var totalqualexnr = Number(0);
                var matchqualexnr = Number(0);
                var matchqualexarr = []
                var totalqualexarr = []

                alllist.forEach(allq => {
                    if (allq.requestedQualex[0] != null) {
                        if (process.env.LOGGING == "TRUE") { console.log('found requestedQualex in question'); }

                        allq.requestedQualex.forEach(reqqe => {

                            var totaladd = Number(1)

                            //set custom scoring
                            if (Array.isArray(reqqe) == false) {
                                if (reqqe.match(/\(\d+\)/gi) != null) {
                                    totaladd = Number(reqqe.match(/\(\d+\)/gi)[0].replace(/\(/gi, "").replace(/\)/gi, ""))
                                }
                            } else {
                                //if synonyms, use the first synonym with scoring for scoring
                                if (JSON.stringify(reqqe).match(/\(\d+\)/gi) != null) {
                                    totaladd = Number(JSON.stringify(reqqe).match(/\(\d+\)/gi)[0].replace(/\(/gi, "").replace(/\)/gi, ""))
                                }

                            }

                            //add to total
                            totalqualexnr = totalqualexnr + totaladd;
                            totalqualexarr.push(reqqe);
                            if (process.env.LOGGING == "TRUE") { console.log('adding ' + totaladd + ' to total'); }


                            var perqax = JSON.parse(qmsg.data.msg).tracker.slots.persisted_qualexes;
                            //chekc if offeredqualex is set
                            if (JSON.parse(perqax).offered_qualex != null) {
                                if (process.env.LOGGING == "TRUE") { console.log('found offeredqualex'); }

                                //deal with nested synonyms
                                if (Array.isArray(reqqe) == false) {
                                    //remiove custom scoring
                                    var reqqeval = reqqe.replace(/\(\d+\)/gi, "")

                                    //reqqe with wildcard   
                                    var reqqewildcard = false
                                    if (reqqeval.includes("*")) {
                                        reqqewildcard = true
                                    }

                                    JSON.parse(perqax).offered_qualex.forEach(offqe => {

                                        if (Array.isArray(offqe) == false) {
                                            //remove custom scoring
                                            var offqeval = offqe.replace(/\(\d+\)/gi, "")

                                            if (reqqewildcard) {
                                                if (offqeval.toUpperCase().trim().includes(reqqeval.replace(/\*/gi, "").toUpperCase().trim())) {
                                                    //avoid duplicates
                                                    if (matchqualexarr.includes(reqqe) == false) {
                                                        matchqualexnr = matchqualexnr + totaladd
                                                        matchqualexarr.push(reqqe);
                                                        if (process.env.LOGGING == "TRUE") { console.log('adding ' + totaladd + ' to matchedtotal'); }
                                                    }
                                                }
                                            } else {
                                                if (offqeval.toUpperCase().trim() == reqqeval.toUpperCase().trim()) {
                                                    //avoid duplicates
                                                    if (matchqualexarr.includes(reqqe) == false) {
                                                        matchqualexnr = matchqualexnr + totaladd
                                                        matchqualexarr.push(reqqe);
                                                        if (process.env.LOGGING == "TRUE") { console.log('adding ' + totaladd + ' to matchedtotal'); }
                                                    }
                                                }
                                            }
                                        } else {
                                            var offqeoffqematch = false
                                            offqe.forEach(offqeoffqe => {
                                                //revome custom scoring
                                                var offqeoffqeval = offqeoffqe.replace(/\(\d+\)/gi, "")

                                                if (reqqewildcard) {
                                                    if (offqeoffqeval.toUpperCase().trim().includes(reqqeval.replace(/\*/gi, "").toUpperCase().trim())) {
                                                        offqeoffqematch = true
                                                    }
                                                } else {
                                                    if (offqeoffqeval.toUpperCase().trim() == reqqeval.toUpperCase().trim()) {
                                                        offqeoffqematch = true
                                                    }
                                                }
                                            });

                                            if (offqeoffqematch) {
                                                //avoid duplicates
                                                if (matchqualexarr.includes(reqqe) == false) {
                                                    matchqualexnr = matchqualexnr + totaladd
                                                    matchqualexarr.push(reqqe);
                                                    if (process.env.LOGGING == "TRUE") { console.log('adding ' + totaladd + ' to matchedtotal'); }
                                                }
                                            }
                                        }
                                    });

                                } else {
                                    var reqqereqqematch = false

                                    reqqe.forEach(reqqereqqe => {
                                        //remove custom scoring
                                        var reqqereqqeval = reqqereqqe.replace(/\(\d+\)/gi, "")

                                        //reqqe with wildcard   
                                        var reqqereqqewildcard = false
                                        if (reqqereqqeval.includes("*")) {
                                            reqqereqqewildcard = true
                                        }

                                        JSON.parse(perqax).offered_qualex.forEach(offqe => {
                                            if (Array.isArray(offqe) == false) {
                                                //remove custom scoring
                                                var offqeval = offqe.replace(/\(\d+\)/gi, "")

                                                if (reqqereqqewildcard) {
                                                    if (offqeval.toUpperCase().trim().includes(reqqereqqeval.replace(/\*/gi, "").toUpperCase().trim())) {
                                                        reqqereqqematch = true
                                                    }
                                                } else {
                                                    if (offqeval.toUpperCase().trim() == reqqereqqeval.toUpperCase().trim()) {
                                                        reqqereqqematch = true
                                                    }
                                                }
                                            } else {
                                                var offqeoffqematch = false
                                                offqe.forEach(offqeoffqe => {
                                                    //remove custom scoring
                                                    var offqeoffqeval = offqeoffqe.replace(/\(\d+\)/gi, "")

                                                    if (reqqereqqewildcard) {
                                                        if (offqeoffqeval.toUpperCase().trim().includes(reqqereqqeval.replace(/\*/gi, "").toUpperCase().trim())) {
                                                            offqeoffqematch = true
                                                        }
                                                    } else {
                                                        if (offqeoffqeval.toUpperCase().trim() == reqqereqqeval.toUpperCase().trim()) {
                                                            offqeoffqematch = true
                                                        }
                                                    }

                                                });

                                                if (offqeoffqematch) {
                                                    reqqereqqematch = true
                                                }
                                            }
                                        });
                                    });

                                    if (reqqereqqematch) {
                                        //avoid duplicates
                                        if (matchqualexarr.includes(reqqe) == false) {
                                            matchqualexnr = matchqualexnr + totaladd;
                                            matchqualexarr.push(reqqe);
                                        }

                                        if (process.env.LOGGING == "TRUE") { console.log('adding ' + totaladd + ' to matchedtotal'); }
                                    }
                                }
                            } else {
                                if (process.env.LOGGING == "TRUE") { console.log('no offeredqualex found'); }
                            }

                        });
                    } else {
                        if (process.env.LOGGING == "TRUE") { console.log('thats weird, no requestedQualex found'); }
                    };
                });

                //calculate percentage
                if (process.env.LOGGING == "TRUE") { console.log('calculating percentage now'); }

                if (totalqualexnr != 0) {
                    var perc = matchqualexnr * 100 / totalqualexnr;
                    if (process.env.LOGGING == "TRUE") { console.log('calculated percentage is' + perc + ' Totalqualex is ' + totalqualexnr + ' Matchedqualex is ' + matchqualexnr); }
                    query.setvalue = { percentage: perc.toFixed(1), matchqualexpoints: matchqualexnr, totalqualexpoints: totalqualexnr, matchedqualex: matchqualexarr, totalevaluatedqualex: totalqualexarr };
                } else {
                    query.setvalue = { percentage: 0, matchqualexpoints: 0, totalqualexpoints: 0, matchedqualex: matchqualexarr, totalevaluatedqualex: totalqualexarr };
                }

            } else {
                query.setvalue = [];

                if (actionvars.nextactionn != "") {
                    actionvars.nextactionp = actionvars.nextactionn;
                }
            }

            postBackResults(callbackq, user, query, originalreq, actionvars);
        } catch (e) {
            if (process.env.ERRORLOGGING == "TRUE") { console.log('error at set_matchpercentage: ' + e); }
        }
    }
}).catch(e => {
    console.error(e); process.exit(1)
});

//Helper functions
//JaroWrinker string similarity
function getJaroWrinkerStringSimilarityWeight(s1, s2) {
    var m = 0;

    // Exit early if either are empty.
    if (s1.length === 0 || s2.length === 0) {
        return 0;
    }

    // Exit early if they're an exact match.
    if (s1 === s2) {
        return 1;
    }

    var range = (Math.floor(Math.max(s1.length, s2.length) / 2)) - 1;
    var s1Matches = new Array(s1.length);
    var s2Matches = new Array(s2.length);

    for (var i = 0; i < s1.length; i++) {
        var low = (i >= range) ? i - range : 0,
            high = (i + range <= s2.length) ? (i + range) : (s2.length - 1);

        for (var j = low; j <= high; j++) {
            if (s1Matches[i] !== true && s2Matches[j] !== true && s1[i] === s2[j]) {
                ++m;
                s1Matches[i] = s2Matches[j] = true;
                break;
            }
        }
    }

    // Exit early if no matches were found.
    if (m === 0) {
        return 0;
    }

    // Count the transpositions.
    var n_trans
    var k = n_trans = 0;

    for (var i = 0; i < s1.length; i++) {
        if (s1Matches[i] === true) {
            for (j = k; j < s2.length; j++) {
                if (s2Matches[j] === true) {
                    k = j + 1;
                    break;
                }
            }

            if (s1[i] !== s2[j]) {
                ++n_trans;
            }
        }
    }

    var weight = (m / s1.length + m / s2.length + (m - (n_trans / 2)) / m) / 3,
        l = 0,
        p = 0.1;

    if (weight > 0.7) {
        while (s1[l] === s2[l] && l < 4) {
            ++l;
        }

        weight = weight + l * p * (1 - weight);
    }

    return weight;
};

//email obfuscation
function obfuscateEmail(s) {
    var i = s.indexOf('@');
    var startIndex = i * .2 | 0;
    var endIndex = i * .9 | 0;
    return s.slice(0, startIndex) +
        s.slice(startIndex, endIndex).replace(/./g, '*') +
        s.slice(endIndex);
}
//percentage issue in chatbotquestions and answers
function cleanOutboundUserMessage(outboundmessage) {

    //Quick fix - decode %
    outboundmessage = outboundmessage.replace(/&percnt/gi, "%")

    //retrun clean message
    return outboundmessage
}

//uservariables
function fillUservariablesInOutboundMessage(outboundmessage,uservariables) {
    try{
        //check if uservariables included in outbound message
        if (outboundmessage.includes("{[")) {
            var possibleuservars = outboundmessage.match(/\{\[(.*?)\]\}/g)

            if(possibleuservars!=null){
                possibleuservars.forEach(puv => {
                    if(uservariables[puv.replace("{[","").replace("]}","")]!=null){
                        //replace placeholder with variable value
                        outboundmessage.replace(puv,uservariables[puv.replace("{[","").replace("]}","")])
                    }
                });
            }

        }

    }catch (e) {
        if (process.env.ERRORLOGGING == "TRUE") { console.log('error fillUservariablesInOutboundMessage: ' + e); }
    }

    return outboundmessage
}

//return conversations from tracker
function returnConversationAsObject(tracker, owner, respondent) {
    try {
        var storyEN = []

        var conversationstarted = false
        var conversationover = false

        tracker.events.forEach(ev => {
            //create story

            if (conversationstarted && conversationover == false) {
                //convert rasa timestamps with separator to normal ts
                var ts = ev.timestamp
                if (isTimestampWithSeparator(ts)) {
                    ts = parseInt(ts.toString().replace(".", "").slice(0, 13))
                }

                if (ev.event == "user") {
                    if (ev.metadata.hasOwnProperty("is_external") == false) {
                        storyEN.push({ timestamp: ts, text: ev.text, user: respondent, chatliateresponse: "false" })
                    }
                }

                if (ev.event == "bot") {
                    //prep bot text with html in it, by removing all tags except the text tag
                    var bottext = ev.text.replace(/<buttons.*>((.|\n)*?)<\/buttons>/gi, "").replace(/<adminset.*>((.|\n)*?)<\/adminset>/gi, "").replace("<text>", "").replace("</text>", "").replace("<utterance>", "").replace("</utterance>", "")

                    storyEN.push({ timestamp: ts, text: bottext, user: owner, chatliateresponse: "true" })
                }
            }

            //start story from apply chatbot intent, stop when you refer back
            if (ev.event == "user") {
                if (conversationstarted == false) {
                    if (ev.parse_data.entities[0] != null) {
                        ev.parse_data.entities.forEach(stent => {
                            if (stent.entity == "chatbotapplication") {
                                conversationstarted = true
                            }
                        });
                    }
                }

                if (ev.parse_data.intent.name == "instruct_utter_application_forwarded") {
                    conversationover = true
                }

            }
        });

        return storyEN

    } catch (e) {
        if (process.env.ERRORLOGGING == "TRUE") { console.log('error returnConversation: ' + e); }
    }
}

function isValidEmail(str) {
    var patt = new RegExp(
        "^([a-zA-Z0-9_\\-\\.]+)@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.)|(([a-zA-Z0-9\\-]+\.)+))([a-zA-Z]{2,4}|[0-9]{1,3})(\]?)$", "i"
    );
    return patt.test(str);
}

function obfuscateEmailsInString(str) {

    return str.replace(/(^|\b)([a-zA-Z0-9_\\-\\.]+)@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.)|(([a-zA-Z0-9\\-]+\.)+))([a-zA-Z]{2,4}|[0-9]{1,3})(\]?)($|\b)/gi, function (x) {
        return obfuscateEmail(x);
    });
}

function isTimestampWithSeparator(str) {
    var patt = new RegExp(
        "^[0-9]{10}[.]", "i"
    );
    return patt.test(str);
}

function checkMatchDoNotUtter(question, qualexlist) {
    var res = false;
    if (process.env.LOGGING == "TRUE") { console.log('checkMatchDoNotUtter'); }

    if (question.utterWhenAlreadyMatched == 'false') {
        //check if there is a match with the provided qualexlist
        if (question.requestedQualex != null) {
            res = checkIfSingleMatch(question.requestedQualex, qualexlist)
        }

    }
    return res
}

function checkIfSingleMatch(lista, listb) {
    if (process.env.LOGGING == "TRUE") { console.log('checkIfSingleMatch'); }

    var res = false;

    if (matchLists(lista, listb)[0] != null) {
        res = true;
    }

    return res;
}


function matchLists(lista, listb) {
    if (process.env.LOGGING == "TRUE") { console.log('matchLists'); }

    var res = [];

    lista.forEach(a => {

        //support 1 layer nested array for synonyms. Check for wildcards in list a
        if (Array.isArray(a) == false) {

            //remove custom scoring
            var aval = a.replace(/\(\d+\)/gi, "")

            listb.forEach(b => {
                if (Array.isArray(b) == false) {

                    //remove custom scoring
                    var bval = b.replace(/\(\d+\)/gi, "")

                    if (aval.includes("*") == false) {
                        if (process.env.LOGGING == "TRUE") { console.log('regular matching 1 aval:' + aval.toUpperCase().trim() + ' bval:' + bval.toUpperCase().trim()); }
                        if (aval.toUpperCase().trim() == bval.toUpperCase().trim()) {
                            res.push(a);
                            if (process.env.LOGGING == "TRUE") { console.log('regular match found 1 '); }
                        }
                    } else {
                        //wildcard search, irrespective of position of wildcard
                        if (process.env.LOGGING == "TRUE") { console.log('wildcard found 1. Comparing aval:' + aval + ' comparing bval:' + bval.toUpperCase().trim()); }
                        if (bval.toUpperCase().trim().includes(aval.replace(/\*/gi, "").toUpperCase().trim())) {
                            res.push(a);
                            if (process.env.LOGGING == "TRUE") { console.log('wildcard match found 1'); }
                        }
                    }
                } else {
                    b.forEach(bb => {
                        //remove custom scoring
                        var bbval = bb.replace(/\(\d+\)/gi, "")

                        if (aval.includes("*") == false) {
                            if (process.env.LOGGING == "TRUE") { console.log('regular matching 2 aval:' + aval.toUpperCase().trim() + ' bbval:' + bbval.toUpperCase().trim()); }
                            if (aval.toUpperCase().trim() == bbval.toUpperCase().trim()) {
                                res.push(a);
                                if (process.env.LOGGING == "TRUE") { console.log('regular match found 2 '); }
                            }
                        } else {
                            //wildcard search, irrespective of position of wildcard
                            if (process.env.LOGGING == "TRUE") { console.log('wildcard found 2 Comparing aval:' + aval + ' comparing bbval:' + bbval.toUpperCase().trim()); }
                            if (bbval.toUpperCase().trim().includes(aval.replace(/\*/gi, "").toUpperCase().trim())) {
                                res.push(a);
                                if (process.env.LOGGING == "TRUE") { console.log('wildcard match found 2'); }
                            }
                        }
                    });
                }
            });
        } else {
            a.forEach(aa => {
                var aaval = aa

                listb.forEach(b => {
                    if (Array.isArray(b) == false) {
                        //remove custom scoring
                        var bval = b.replace(/\(\d+\)/gi, "")

                        if (aaval.includes("*") == false) {
                            if (aaval.toUpperCase().trim() == bval.toUpperCase().trim()) {
                                if (process.env.LOGGING == "TRUE") { console.log('regular matching 3 aaval:' + aaval.toUpperCase().trim() + ' bval:' + bval.toUpperCase().trim()); }
                                res.push(aa);
                                if (process.env.LOGGING == "TRUE") { console.log('regular match found 3 '); }
                            }
                        } else {
                            //wildcard search, irrespective of position of wildcard
                            if (process.env.LOGGING == "TRUE") { console.log('wildcard found 3 Comparing aaval:' + aaval + ' comparing bval:' + bval.toUpperCase().trim()); }
                            if (bval.toUpperCase().trim().includes(aaval.replace(/\*/gi, "").toUpperCase().trim())) {
                                res.push(aa);
                                if (process.env.LOGGING == "TRUE") { console.log('wildcard match found 3'); }
                            }
                        }
                    } else {
                        b.forEach(bb => {
                            //remove custom scoring
                            var bbval = bb.replace(/\(\d+\)/gi, "")

                            if (aaval.includes("*") == false) {
                                if (process.env.LOGGING == "TRUE") { console.log('regular matching 4 aaval:' + aaval.toUpperCase().trim() + ' bbval:' + bbval.toUpperCase().trim()); }
                                if (aaval.toUpperCase().trim() == bbval.toUpperCase().trim()) {
                                    res.push(aa);
                                    if (process.env.LOGGING == "TRUE") { console.log('regular match found 4 '); }
                                }
                            } else {
                                //wildcard search, irrespective of position of wildcard
                                if (process.env.LOGGING == "TRUE") { console.log('wildcard found 4 Comparing aaval:' + aaval + ' comparing bbval:' + bbval.toUpperCase().trim()); }
                                if (bbval.toUpperCase().trim().includes(aaval.replace(/\*/gi, "").toUpperCase().trim())) {
                                    res.push(aa);
                                    if (process.env.LOGGING == "TRUE") { console.log('wildcard match found 4'); }
                                }
                            }
                        });
                    }
                });
            });
        }
    });

    return res;
}

function removeNestedIndicators(actstr) {

    actstr = actstr.replace(/action1/gi, "action");
    actstr = actstr.replace(/sn1/gi, "sn");
    actstr = actstr.replace(/sdn1/gi, "sdn");
    actstr = actstr.replace(/nap1/gi, "nap");
    actstr = actstr.replace(/nan1/gi, "nan");
    actstr = actstr.replace(/da1/gi, "da");
    actstr = actstr.replace(/la1/gi, "la");

    return actstr;
}

function parseActionVars(msg) {
    var vars = {};

    //actionregxps
    var acregx = new RegExp("action_(.*?)_sn_");
    var snregx = new RegExp("_sn_(.*?)_sdn_");
    var dsnregx = new RegExp("_sdn_(.*?)_nap_");
    var napregx = new RegExp("_nap_(.*?)_nan_");
    var nanregx = new RegExp("_nan_(.*?)_da_");
    var daregx = new RegExp("_da_(.*?)_la_");
    var laregx = new RegExp("_la_(.*?)$");

    vars.action = acregx.exec(JSON.parse(msg).next_action)[1]
    vars.slotname = snregx.exec(JSON.parse(msg).next_action)[1]
    vars.deletedslotname = dsnregx.exec(JSON.parse(msg).next_action)[1]

    //for next action positive, remove nested action indicators 1
    vars.nextactionp = removeNestedIndicators(napregx.exec(JSON.parse(msg).next_action)[1]);

    //for next action negative, remove nested action indicators 1
    vars.nextactionn = removeNestedIndicators(nanregx.exec(JSON.parse(msg).next_action)[1]);

    vars.displayas = daregx.exec(JSON.parse(msg).next_action)[1]
    vars.listenafter = laregx.exec(JSON.parse(msg).next_action)[1]

    return vars;
}

function formatResponse(res, displayas, tracker) {
    if (process.env.LOGGING == "TRUE") { console.log('Formatter Response. '); }

    var r = res;

    //no length, no formattiung needed
    if (res[0] != null) {

        //modify to xml button template
        if (displayas == "button") {
            if (process.env.LOGGING == "TRUE") { console.log('Format required: button'); }
            r = "";
            res.forEach(element => {
                r = r + "<button><title>" + element.title + "</title><payload>" + element.title + ". ref: " + element.chatbotid + "</payload></button>";
            });
        }
        if (displayas == "xmlconversation") {
            if (process.env.LOGGING == "TRUE") { console.log('Format required: xmlconversation'); }

            if (res[0].conversation != null) {

                r = "<id>" + res[0]._id + "</id>";

                if (res[0].conversationsubject != null) {
                    r = r + "<conversationsubject>" + res[0].conversationsubject + "</conversationsubject>";
                }

                if (res[0].tenantsettings != null) {
                    r = r + "<tenantsettings>" + encodeURIComponent(JSON.stringify(res[0].tenantsettings)) + "</tenantsettings>";
                }

                r = r + "<users>" + encodeURIComponent(JSON.stringify(res[0].users)) + "</users>";

                res[0].conversation.forEach(element => {
                    var user = "otheruser"

                    if (tracker.slots.conversation_email != null) {
                        //set user
                        if (element.user == tracker.slots.conversation_email) {
                            user = "chatuser"
                        }
                    }

                    r = r + "<message><timestamp>" + element.timestamp + "</timestamp><user>" + user + "</user><text>" + element.text + "</text><chatliateresponse>" + element.chatliateresponse + "</chatliateresponse></message>";
                });
            }

        }
        if (displayas == "xmllist") {
            if (process.env.LOGGING == "TRUE") { console.log('Format required: xmllist'); }
            r = "";
            var url = "";

            res.forEach(element => {
                url = element.url;

                //format url to chatbotboard if present
                if (element.chatbotboardurl != null) {
                    url = element.chatbotboardurl + "?chatbotid=" + element.chatbotid;
                }

                r = r + "<chatbot><chatbotid>" + element.chatbotid + "</chatbotid><title>" + element.title + "</title><subtitle>" + element.subtitle + "</subtitle><description>" + element.description + "</description><url>" + url + "</url><imageurl>" + element.imageurl + "</imageurl><buttons><button><title>" + element.viewtitle + "</title><url>" + url + "</url></button><button><title>" + element.applytitle + "</title><payload>I'd like to apply for chatbot ref " + element.chatbotid + "</payload></button></buttons></chatbot>";
            });
        }
        if (displayas == "chatbotid") {
            if (process.env.LOGGING == "TRUE") { console.log('Format required: chatbotid'); }
            if (res[0].chatbotid != null) {
                r = res[0].chatbotid;
            }
        }
        //if(process.env.LOGGING=="TRUE"){console.log('No valid displayas found. displayas value: '+displayas);}

    } else {
        if (process.env.LOGGING == "TRUE") { console.log('Empty result. No formatting needed'); }
    }

    return r;
}

function postBackResults(callbackq, user, query, originalreq, actionvars) {
    if (process.env.LOGGING == "TRUE") { console.log('postBackResults called. '); }
    // positive next action is default  
    var nextaction = actionvars.nextactionp;

    //if db needs to be queried, setvalue is null
    if (query.setvalue == null) {
        //add info for postback
        originalreq.callbackq = callbackq;
        originalreq.actionvars = actionvars;

        //post to inbounddatabase
        postToInboundDbRequestQueue(user, JSON.stringify({
            originalreq: originalreq,
            query: query
        })).catch(e => {
            console.error(e); process.exit(1)
        });

    } else {
        var r = query.setvalue

        if (process.env.LOGGING == "TRUE") { console.log('prepping to postback. '); }

        //post chatbots back to Rasa action Q if val,ue is set
        postToOutboundRasaActionQueue(callbackq, user, JSON.stringify({
            originalreq: originalreq,
            nextaction: nextaction,
            listenafter: actionvars.listenafter,
            slotname: actionvars.slotname,
            deletedslotname: actionvars.deletedslotname,
            result: r
        })).catch(e => {
            console.error(e); process.exit(1)
        });
    }

};

//DB queues
//Monitor inbound DB requests and post back
async function postToInboundDbRequestQueue(user, msg) {
    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator adding dbrequest to inboundDbRequestQueue. '); }

    var adb = await inboundDbRequestQueue.add({
        user: user,
        callbackq: process.env.DBREQUESTOUTBOUNDQ,
        msg: msg
    }, { removeOnComplete: true });

    //if(process.env.LOGGING=="TRUE"){console.log('Result of post is: '+ JSON.stringify(adb));}

};


outboundDbRequestQueue.process(async (qmsg) => {

    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator reading from outboundDbRequestQueue.  for User: '); }

    //generic vars
    var user = qmsg.data.user;

    //var actionvars = parseActionVars(qmsg.data.msg);
    var originalreq = JSON.parse(qmsg.data.msg).originalreq;
    var result = JSON.parse(qmsg.data.msg).result;
    var query = { setvalue: formatResponse(result, originalreq.actionvars.displayas, originalreq.tracker) };


    //in case 0 returned and nextactionn is set, do negative action 
    if (result[0] == null && originalreq.actionvars.nextactionn != "") {
        originalreq.actionvars.nextactionp = originalreq.actionvars.nextactionn;
    }

    postBackResults(originalreq.callbackq, user, query, originalreq, originalreq.actionvars);

}).catch(e => {
    console.error(e); process.exit(1)
});

//stats DB
//Monitor inbound DB requests and post back
async function postToInboundStatsDbRequestQueue(user, msg) {
    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator adding dbrequest to inboundStatsDbRequestQueue. '); }

    var adb = await inboundStatsDbRequestQueue.add({
        user: user,
        callbackq: process.env.STATSDBREQUESTOUTBOUNDQ,
        msg: msg
    }, { removeOnComplete: true });

    //if(process.env.LOGGING=="TRUE"){console.log('Result of post is: '+ JSON.stringify(adb));}

};


outboundStatsDbRequestQueue.process(async (qmsg) => {

    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator reading from outboundStatsDbRequestQueue.  for User: '); }

    //generic vars
    var user = qmsg.data.user;

    //var actionvars = parseActionVars(qmsg.data.msg);
    var originalreq = JSON.parse(qmsg.data.msg).originalreq;
    var result = JSON.parse(qmsg.data.msg).result;


}).catch(e => {
    console.error(e); process.exit(1)
});

//COMMUNICATOR QUEUES
//Post to communicator
async function postToCommunicatorQueue(user, msg) {
    if (process.env.LOGGING == "TRUE") { console.log('Orchestrator adding comms to communicatorOutboundQueue. '); }

    var adb = await communicatorOutboundQueue.add({
        user: user,
        msg: msg
    }, { removeOnComplete: true });

    //if(process.env.LOGGING=="TRUE"){console.log('Result of post is: '+ JSON.stringify(adb));}

};

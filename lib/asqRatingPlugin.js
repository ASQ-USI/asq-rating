var ASQPlugin = require('asq-plugin');
var ObjectId = require('mongoose').Types.ObjectId;
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-rating',

  hooks:{
    "parse_html" : "parseHtml",
    "answer_submission" : "answerSubmission",
    "edit_answer_submission" : "editAnswerSubmission",
    // "receivedAnswer" : receivedAnswer,
    // "autoAssess" : autoAssess 
  },

  parseHtml: function(html){
    var $ = cheerio.load(html, {decodeEntities: false});
    var ratingQuestions = [];

    $(this.tagName).each(function(idx, el){
      ratingQuestions.push(this.processEl($, el));
    }.bind(this));

    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(ratingQuestions)
    .then(function(){
      return Promise.resolve($.root().html());
    });
    
  },

  editAnswerSubmission: coroutine(function *editAnswerSubmissionGen (answer) {
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    if(question.type !== this.tagName) {
      return answer;
    }

    // make sure options are valid
    var options = answer.submission
    assert(_.isArray(options),
      'Invalid answer format, answer.submission should be an array.');

    var sanitized = [];
    var sOptionUids = options.map(function optionMap(option){
      //sanitize
      var option = _.pick(option, 'uid', 'value');
       assert(ObjectId.isValid(option.uid),
        'Invalid answer format, option should have a uid property');

      sanitized.push({_id: ObjectId(option.uid), value: option.value})

      return option.uid;
    });

    var qOptionUids = question.data.options.map(function optionMap2(option){
      return option._id.toString();
    })

    //check if the arrays have the same elements
    assert(_.isEmpty(_.xor(qOptionUids, sOptionUids)),
      'Invalid answer, submitted option uids do not match those in the database');

    answer.submission = sanitized;

    // ### TODD modify to database 
    // ### TODD option1. delete old and add new one
    // ### TODD option2. modify directly

    // yield this.asq.db.model("Answer").create({
    //   exercise   : answer.exercise_id,
    //   question   : questionUid,
    //   answeree   : answer.answeree,
    //   session    : answer.session,
    //   submitDate : Date.now(),
    //   submission : answer.submission,
    //   confidence : answer.confidence
    // });

    this.calculateEditProgress(answer.session, ObjectId(questionUid));
    
    return answer;
  }),

  calculateEditProgress: coroutine(function *calculateEditProgressGen(session_id, question_id){

    var criteria = {session: session_id, question:question_id};
    var answers = yield this.asq.db.model('Answer').find(criteria).lean().exec();
    var options = {};
    answers.reduce(function reduceAnswers(options, answer){
      answer.submission.forEach(function forEachSubmission(sub){
        if(sub.value == false) return;

        //options is true so add it
        var id = sub._id.toString();
        options[id] = options[id] || 0;
        // ### TODD should be changed to `++`
        options[id]--;
      })
      return options;
    }, options);

    var event = {
      questionType: this.tagName,
      type: 'progress_edit',
      questionUid: question_id.toString(),
      options: options,
      total: answers.length
    }
    console.log("BEFORE GOING BACK", event);
    this.asq.command('sendSocketEventToNamespaces', 'asq:question_type_edit', event, session_id.toString(), 'ctrl')
  }),

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-rating question
    if(question.type !== this.tagName) {
      return answer;
    }

    // make sure options are valid
    var options = answer.submission
    assert(_.isArray(options),
      'Invalid answer format, answer.submission should be an array.');

    console.log(answer, options);

    var sanitized = [];
    var sOptionUids = options.map(function optionMap(option){
      //sanitize
      var option = _.pick(option, 'uid', 'value');
       assert(ObjectId.isValid(option.uid),
        'Invalid answer format, option should have a uid property');

      sanitized.push({_id: ObjectId(option.uid), value: option.value})

      return option.uid;
    });

    console.log(sanitized);

    var qOptionUids = question.data.options.map(function optionMap2(option){
      return option._id.toString();
    })

    //check if the arrays have the same elements
    assert(_.isEmpty(_.xor(qOptionUids, sOptionUids)),
      'Invalid answer, submitted option uids do not match those in the database');

    answer.submission = sanitized;

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    this.calculateProgress(answer.session, ObjectId(questionUid));

    //this will be the argument to the next hook
    return answer;
  }),

  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var criteria = {session: session_id, question:question_id};
    var answers = yield this.asq.db.model('Answer').find(criteria).lean().exec();
    var options = {};
    answers.reduce(function reduceAnswers(options, answer){
      answer.submission.forEach(function forEachSubmission(sub){
        if(sub.value == false) return;

        //options is true so add it
        var id = sub._id.toString();
        options[id] = options[id] || 0;
        options[id]++;
      })
      return options;
    }, options);

    var event = {
      questionType: this.tagName,
      type: 'progress',
      questionUid: question_id.toString(),
      options: options,
      total: answers.length
    }

    this.asq.command('sendSocketEventToNamespaces', 'asq:question_type', event, session_id.toString(), 'ctrl')
  }),

  processEl: function($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    //parse options
    var items = this.parseRatingItems($, el);

    return {
      _id : uid,
      type: this.tagName,
      data: {
        stem: stem,
        ratingItems: items
      }
    }

  },

  parseRatingItems: function($, el){
   
    var dbRatingItems = [];
    var ids = Object.create(null);
    var $el = $(el);

    var $asqRatingItems = $el.find('asq-rating-item');
    assert($asqRatingItems.length > 0
      , 'An asq-rating question should have at least one `asq-rating-item` child' )

    $asqRatingItems.each(function(idx, item){
      item = $(item);


      //make sure rating items are id'ed
      var uid = item.attr('uid');
      if(uid == undefined || uid.trim() == ''){
        item.attr('uid', uid = ObjectId().toString() );
      } 

      assert(!ids[uid]
        , 'A asq-rating question cannot have two `asq-rating-items` with the same uids' );
     
      ids[uid] = true;

      //check if the options is marked as a correct choice
      var type = item.attr('type') || 'stars';

      dbRatingItems.push({
        _id : ObjectId(uid),
        html: item.html(),
        type : type
      });
    });

    return dbRatingItems;
  } 
});
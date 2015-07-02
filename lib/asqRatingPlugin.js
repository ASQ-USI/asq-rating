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
    "presenter_connected" : "presenterConnected",
    "viewer_connected" : "viewerConnected"
  },

  parseHtml: function(options){
    var $ = cheerio.load(options.html, {decodeEntities: false});
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

    // make sure rating items are valid
    var ratingItems = answer.submission
    assert(_.isArray(ratingItems),
      'Invalid answer format, answer.submission should be an array.');

    var sanitized = [];
    var sRatingItemsUids = ratingItems.map(function ratingItemMap(rItem){
      //sanitize
      var rItem = _.pick(rItem, 'uid', 'rating');
       assert(ObjectId.isValid(rItem.uid),
        'Invalid answer format, rating item should have a uid property');

      sanitized.push({_id: ObjectId(rItem.uid), rating: rItem.rating})

      return rItem.uid;
    });

    var qRatingItemsUids = question.data.ratingItems.map(function ratingItemMap2(rItem){
      return rItem._id.toString();
    })

    //check if the arrays have the same elements
    assert(_.isEmpty(_.xor(qRatingItemsUids, sRatingItemsUids)),
      'Invalid answer, submitted rating items uids do not match those in the database');

    answer.submission = sanitized;

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      type       : question.type,
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
    var pipeline = [
      { $match: {
          session: session_id,
          question : question_id
        }
      },
      {$sort:{"submitDate":-1}},
      { $group:{
          "_id":"$answeree",
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $unwind: "$submission" },
      { $group:{
          "_id":"$submission._id",
          "rating":{$avg: "$submission.rating"}
        }
      }
    ]
    var ratings = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var ratingsMap = {};
    ratings.forEach(function(rating){
      ratingsMap[rating._id] = rating.rating;
    });


    var event = {
      questionType: this.tagName,
      type: 'progress',
      question: {
        uid: question_id.toString(),
        ratings: ratingsMap
      }
    }

    this.asq.socket.emitToRoles('asq:question_type', event, session_id.toString(), 'ctrl')
  }),

  copyRatings : function(aggrRating, question){
    for(var i = 0, l = aggrRating.ratingItems.length; i<l; i++){
      for(var j = 0, l2 = question.data.ratingItems.length; j<l2; j++){
        if(aggrRating.ratingItems[i]._id.toString()  == question.data.ratingItems[j]._id){
          question.data.ratingItems[j].rating = aggrRating.ratingItems[i].rating;
          break;
        }
      }
    }
  },
  
  restorePresenterForSession: coroutine(function *restorePresenterForSessionGen(session_id, presentation_id){
    
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          session: session_id,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id":{
            "answeree" : "$answeree",
            "question" : "$question"
          },
          "submitDate":{$first:"$submitDate"},
          "submission": {$first:"$submission"},
        }
      },
      { $unwind: "$submission" },
      { $group:{
          "_id":{
            "question" : "$_id.question",
            "rating_id": "$submission._id"
          },
          "rating":{$avg: "$submission.rating"},
          "submitDate":{$first: "$submitDate"},
          "submission": {$first: "$submission"},
        }
      },
      { $group:{
          "_id": {
            "question" : "$_id.question",
          },
          "ratingItems":{$push: {"_id" : "$_id.rating_id" , "rating": "$rating"}}
        }
      },
      { $project : { 
          "_id": 0,
          "question" : "$_id.question",
          "ratingItems" : 1
        } 
      }
    ]
    var ratings = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    var questionIds = ratings.map(function(rating, index){
      return rating.question;
    });

    var questions = yield this.asq.db.model('Question')
      .find({_id : {$in: questionIds}}).lean().exec();

    questions.forEach(function(q){
      q.uid = q._id.toString();
      for(var i=0, l=ratings.length; i<l; i++){
        if(ratings[i].question.toString() == q._id){
          this.copyRatings(ratings[i], q);
          break;
        }
      }
    }.bind(this));

    return questions;    
  }),

  presenterConnected: coroutine(function *presenterConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithScores = yield this.restorePresenterForSession(info.session_id, info.presentation_id);

    var event = {
      questionType: this.tagName,
      type: 'restorePresenter',
      questions: questionsWithScores
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    //this will be the argument to the next hook
    return info;
  }),

  restoreViewerForSession: coroutine(function *restoreViewerForSessionGen(session_id, presentation_id, whitelistId){
    var questions = yield this.asq.db.getPresentationQuestionsByType(presentation_id, this.tagName);
    var questionIds = questions.map(function(q){
      return q._id;
    });

    var pipeline = [
      { $match: {
          "session": session_id,
          "answeree" : whitelistId,
          "question" : {$in : questionIds}
        }
      },
      { $sort:{"submitDate": -1}},
      { $group:{
          "_id": "$question",
          "ratingItems": {$first:"$submission"},
        }
      },
      { $project:{
          "_id": 0,
          "uid" : "$_id",
          "ratingItems": 1,
        }
      }
    ]
    var questionsWithAnswers = yield this.asq.db.model('Answer').aggregate(pipeline).exec();

    return questionsWithAnswers;    
  }),

  viewerConnected: coroutine(function *viewerConnectedGen (info){

    if(! info.session_id) return info;

    var questionsWithAnswers = yield this.restoreViewerForSession(info.session_id, info.presentation_id, info.whitelistId);

    var event = {
      questionType: this.tagName,
      type: 'restoreViewer',
      questions: questionsWithAnswers
    }

    this.asq.socket.emit('asq:question_type', event, info.socketId)

    // this will be the argument to the next hook
    return info;
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